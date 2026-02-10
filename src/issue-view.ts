import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import chalk from 'chalk'
import sanitize from 'sanitize-filename'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import type { Image, Link, Root } from 'mdast'
import { linear } from './linear'

type IssueRef = {
  identifier: string
  title: string
  state: { name: string; color: string }
}

type Comment = {
  id: string
  body: string
  createdAt: string
  user?: { name: string; displayName: string } | null
  externalUser?: { name: string; displayName: string } | null
  parent?: { id: string } | null
}

type Attachment = {
  id: string
  title: string
  url: string
  subtitle?: string | null
  sourceType?: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

type IssueDetails = {
  identifier: string
  title: string
  description?: string | null
  url: string
  branchName: string
  state: { name: string; color: string }
  parent?: IssueRef | null
  children?: IssueRef[]
  comments?: Comment[]
  attachments?: Attachment[]
}

const ISSUE_QUERY = `
  query GetIssueDetails($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      url
      branchName
      state { name color }
      parent {
        identifier title
        state { name color }
      }
      children(first: 250) {
        nodes {
          identifier title
          state { name color }
        }
      }
      comments(first: 50, orderBy: createdAt) {
        nodes {
          id body createdAt
          user { name displayName }
          externalUser { name displayName }
          parent { id }
        }
      }
      attachments(first: 50) {
        nodes {
          id title url subtitle sourceType metadata createdAt
        }
      }
    }
  }
`

async function fetchIssueDetails(issueId: string): Promise<IssueDetails> {
  const data = await linear.query<{ issue: any }>(ISSUE_QUERY, { id: issueId })
  return {
    ...data.issue,
    children: data.issue.children?.nodes ?? [],
    comments: data.issue.comments?.nodes ?? [],
    attachments: data.issue.attachments?.nodes ?? [],
  }
}

export async function viewIssue(issueId: string, opts: { download?: boolean } = {}): Promise<void> {
  const shouldDownload = opts.download !== false

  const issueData = await fetchIssueDetails(issueId)

  let urlToPath: Map<string, string> | undefined
  if (shouldDownload) {
    urlToPath = await downloadIssueImages(issueData.description, issueData.comments)
  }

  let attachmentPaths: Map<string, string> | undefined
  if (shouldDownload && issueData.attachments && issueData.attachments.length > 0) {
    attachmentPaths = await downloadAttachments(issueData.identifier, issueData.attachments)
  }

  let { description } = issueData
  let comments = issueData.comments

  if (urlToPath && urlToPath.size > 0) {
    if (description) {
      description = await replaceImageUrls(description, urlToPath)
    }
    if (comments) {
      comments = await Promise.all(
        comments.map(async (c) => ({ ...c, body: await replaceImageUrls(c.body, urlToPath!) })),
      )
    }
  }

  const { identifier, title } = issueData
  let markdown = `# ${identifier}: ${title}${description ? '\n\n' + description : ''}`

  if (process.stdout.isTTY) {
    const width = process.stdout.columns ?? 80

    const md = new Marked(markedTerminal({ width }))
    const rendered = md.parse(markdown) as string
    const outputLines = rendered.split('\n')

    const hierarchyMd = formatIssueHierarchyAsMarkdown(issueData.parent, issueData.children)
    if (hierarchyMd) {
      outputLines.push(...(md.parse(hierarchyMd) as string).split('\n'))
    }

    if (issueData.attachments && issueData.attachments.length > 0) {
      const attMd = formatAttachmentsAsMarkdown(issueData.attachments, attachmentPaths)
      outputLines.push(...(md.parse(attMd) as string).split('\n'))
    }

    if (comments && comments.length > 0) {
      outputLines.push('')
      outputLines.push(...captureCommentsForTerminal(comments, width, md))
    }

    console.log(outputLines.join('\n'))
  } else {
    markdown += formatIssueHierarchyAsMarkdown(issueData.parent, issueData.children)

    if (issueData.attachments && issueData.attachments.length > 0) {
      markdown += formatAttachmentsAsMarkdown(issueData.attachments, attachmentPaths)
    }

    if (comments && comments.length > 0) {
      markdown += '\n\n## Comments\n\n'
      markdown += formatCommentsAsMarkdown(comments)
    }

    console.log(markdown)
  }
}

function formatRelativeTime(dateString: string): string {
  const now = new Date()
  const date = new Date(dateString)
  const diffMs = now.getTime() - date.getTime()
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutes < 60) {
    return diffMinutes <= 1 ? '1 minute ago' : `${diffMinutes} minutes ago`
  } else if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`
  } else if (diffDays < 7) {
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
  } else {
    return date.toLocaleDateString()
  }
}

function getCommentAuthor(c: Comment): string {
  return c.user?.displayName || c.user?.name || c.externalUser?.displayName || c.externalUser?.name || 'Unknown'
}

function formatCommentHeader(author: string, date: string, indent = ''): string {
  return `${indent}${chalk.bold.underline(`@${author}`)} ${chalk.underline(`commented ${date}`)}`
}

function formatIssueHierarchyAsMarkdown(
  parent: IssueRef | null | undefined,
  children: IssueRef[] | undefined,
): string {
  let md = ''
  if (parent) {
    md += `\n\n## Parent\n\n`
    md += `- **${parent.identifier}**: ${parent.title} _[${parent.state.name}]_\n`
  }
  if (children && children.length > 0) {
    md += `\n\n## Sub-issues\n\n`
    for (const child of children) {
      md += `- **${child.identifier}**: ${child.title} _[${child.state.name}]_\n`
    }
  }
  return md
}

function formatAttachmentsAsMarkdown(
  attachments: Attachment[],
  localPaths?: Map<string, string>,
): string {
  if (attachments.length === 0) return ''

  let md = '\n\n## Attachments\n\n'
  for (const att of attachments) {
    const path = localPaths?.get(att.url)
    const sourceLabel = att.sourceType ? ` _[${att.sourceType}]_` : ''
    md += `- **${att.title}**: ${path ?? att.url}${sourceLabel}\n`
    if (att.subtitle) {
      md += `  _${att.subtitle}_\n`
    }
  }
  return md
}

function formatCommentsAsMarkdown(comments: Comment[]): string {
  const rootComments = comments.filter((c) => !c.parent)
  const replies = comments.filter((c) => c.parent)

  const repliesMap = new Map<string, Comment[]>()
  for (const reply of replies) {
    const pid = reply.parent!.id
    if (!repliesMap.has(pid)) repliesMap.set(pid, [])
    repliesMap.get(pid)!.push(reply)
  }

  const sorted = rootComments.slice().reverse()
  let md = ''

  for (const root of sorted) {
    const threadReplies = repliesMap.get(root.id) ?? []
    threadReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    md += `- **@${getCommentAuthor(root)}** - *${formatRelativeTime(root.createdAt)}*\n\n`
    md += `  ${root.body.split('\n').join('\n  ')}\n\n`

    for (const reply of threadReplies) {
      md += `  - **@${getCommentAuthor(reply)}** - *${formatRelativeTime(reply.createdAt)}*\n\n`
      md += `    ${reply.body.split('\n').join('\n    ')}\n\n`
    }
  }

  return md
}

function captureCommentsForTerminal(comments: Comment[], width: number, md: Marked): string[] {
  const rootComments = comments.filter((c) => !c.parent)
  const replies = comments.filter((c) => c.parent)

  const repliesMap = new Map<string, Comment[]>()
  for (const reply of replies) {
    const pid = reply.parent!.id
    if (!repliesMap.has(pid)) repliesMap.set(pid, [])
    repliesMap.get(pid)!.push(reply)
  }

  const sorted = rootComments.slice().reverse()
  const lines: string[] = []
  for (const root of sorted) {
    const threadReplies = repliesMap.get(root.id) ?? []
    threadReplies.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    lines.push(formatCommentHeader(getCommentAuthor(root), formatRelativeTime(root.createdAt)))
    lines.push(...(md.parse(root.body) as string).split('\n'))

    if (threadReplies.length > 0) lines.push('')

    for (const reply of threadReplies) {
      lines.push(formatCommentHeader(getCommentAuthor(reply), formatRelativeTime(reply.createdAt), '  '))
      const rendered = md.parse(reply.body) as string
      lines.push(...rendered.split('\n').map((l) => '  ' + l))
    }

    if (root !== sorted[sorted.length - 1]) lines.push('')
  }

  return lines
}

const IMAGE_CACHE_DIR = join(tmpdir(), 'linear-agent-images')
const ATTACHMENT_CACHE_DIR = join(tmpdir(), 'linear-agent-attachments')

function isLinearUpload(url: string): boolean {
  return url.includes('uploads.linear.app') || url.includes('public.linear.app')
}

function getUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

async function downloadFile(url: string, filepath: string): Promise<void> {
  if (isLinearUpload(url)) {
    const buf = await linear.download(url)
    writeFileSync(filepath, buf)
  } else {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`)
    writeFileSync(filepath, Buffer.from(await resp.arrayBuffer()))
  }
}

interface ImageInfo {
  url: string
  alt: string | null
}

interface LinkInfo {
  url: string
  text: string | null
}

function extractImageInfo(content: string | null | undefined): ImageInfo[] {
  if (!content) return []
  const images: ImageInfo[] = []
  const tree = unified().use(remarkParse).parse(content)
  visit(tree, 'image', (node: Image) => {
    if (node.url) images.push({ url: node.url, alt: node.alt || null })
  })
  return images
}

function extractLinearLinkInfo(content: string | null | undefined): LinkInfo[] {
  if (!content) return []
  const links: LinkInfo[] = []
  const tree = unified().use(remarkParse).parse(content)
  visit(tree, 'link', (node: Link) => {
    if (node.url && isLinearUpload(node.url)) {
      const textNode = node.children[0]
      const text = textNode && textNode.type === 'text' ? textNode.value : null
      links.push({ url: node.url, text })
    }
  })
  return links
}

async function replaceImageUrls(content: string, urlToPath: Map<string, string>): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree: Root) => {
      visit(tree, 'image', (node: Image) => {
        const localPath = urlToPath.get(node.url)
        if (localPath) node.url = localPath
      })
      visit(tree, 'link', (node: Link) => {
        const localPath = urlToPath.get(node.url)
        if (localPath) node.url = localPath
      })
    })
    .use(remarkStringify)

  const result = await processor.process(content)
  return String(result)
}

async function downloadImage(url: string, altText: string | null): Promise<string> {
  const urlHash = getUrlHash(url)
  const imageDir = join(IMAGE_CACHE_DIR, urlHash)
  mkdirSync(imageDir, { recursive: true })

  const filename = altText ? sanitize(altText) : 'image'
  const filepath = join(imageDir, filename)

  if (existsSync(filepath)) return filepath

  await downloadFile(url, filepath)
  return filepath
}

async function downloadIssueImages(
  description: string | null | undefined,
  comments?: Comment[],
): Promise<Map<string, string>> {
  const filesByUrl = new Map<string, string | null>()

  for (const img of extractImageInfo(description)) {
    if (!filesByUrl.has(img.url)) filesByUrl.set(img.url, img.alt)
  }
  for (const link of extractLinearLinkInfo(description)) {
    if (!filesByUrl.has(link.url)) filesByUrl.set(link.url, link.text)
  }

  if (comments) {
    for (const comment of comments) {
      for (const img of extractImageInfo(comment.body)) {
        if (!filesByUrl.has(img.url)) filesByUrl.set(img.url, img.alt)
      }
      for (const link of extractLinearLinkInfo(comment.body)) {
        if (!filesByUrl.has(link.url)) filesByUrl.set(link.url, link.text)
      }
    }
  }

  const urlToPath = new Map<string, string>()
  for (const [url, alt] of filesByUrl) {
    try {
      const path = await downloadImage(url, alt)
      urlToPath.set(url, path)
    } catch (err) {
      console.error(`Failed to download ${url}: ${err instanceof Error ? err.message : err}`)
    }
  }

  return urlToPath
}

async function downloadAttachments(
  issueIdentifier: string,
  attachments: Attachment[],
): Promise<Map<string, string>> {
  const urlToPath = new Map<string, string>()
  const issueDir = join(ATTACHMENT_CACHE_DIR, issueIdentifier)
  mkdirSync(issueDir, { recursive: true })

  for (const att of attachments) {
    if (!isLinearUpload(att.url)) continue

    const filename = sanitize(att.title)
    const filepath = join(issueDir, filename)

    if (existsSync(filepath)) {
      urlToPath.set(att.url, filepath)
      continue
    }

    try {
      await downloadFile(att.url, filepath)
      urlToPath.set(att.url, filepath)
    } catch (err) {
      console.error(`Failed to download attachment "${att.title}": ${err instanceof Error ? err.message : err}`)
    }
  }

  return urlToPath
}

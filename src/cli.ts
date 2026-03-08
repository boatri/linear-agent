#!/usr/bin/env bun
import chalk from 'chalk'
import { Command } from 'commander'
import { chmodSync, renameSync } from 'fs'
import { z } from 'zod'
import { linear } from './linear'
import { resolveGitHubLogin } from './github'
import { Watcher } from './claude/watcher'
import { acquireLock } from './claude/lock'

// Read version from package.json at build time via Bun's bundler
const { version } = await import('../package.json')
const program = new Command().name('linear-agent').version(version, '-v, --version').description('Stream Claude Code sessions to Linear')

program.option('--json', 'Output structured JSON for all commands')

function isJson(): boolean {
  return program.opts().json === true
}

function output(data: Record<string, unknown>): void {
  if (isJson()) {
    console.log(JSON.stringify({ ok: true, ...data }, null, 2))
  } else {
    // Callers handle human-readable output themselves
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  if (isJson()) {
    console.log(JSON.stringify({ ok: false, error: { code, message, ...details } }, null, 2))
  } else {
    console.error(`Error: ${message}`)
  }
  process.exit(1)
}

const watch = program.command('watch').description('Watch an agent backend and emit activities to Linear')

watch
  .command('claude')
  .description('Tail a Claude Code session JSONL and emit activities to Linear')
  .requiredOption('--session-id <id>', 'Linear agent session ID')
  .action(async (opts: { sessionId: string }) => {
    if (!acquireLock(opts.sessionId)) {
      console.log(`Watcher already running for session ${opts.sessionId}`)
      process.exit(0)
    }

    const watcher = new Watcher({ sessionId: opts.sessionId }, linear)
    await watcher.run()
  })

const issue = program.command('issue').description('Manage Linear issues')

issue
  .command('view')
  .description('View issue details')
  .option('--id <issue-id>', 'Issue ID (inferred from LINEAR_AGENT_SESSION_ID if not set)')
  .option('--no-download', 'Keep remote URLs instead of downloading files')
  .option('--all-comments', 'Expand all comment replies')
  .option('--fields <fields>', 'Comma-separated list of fields to include (requires --json)')
  .action(async (opts: { id?: string; download?: boolean; allComments?: boolean; fields?: string }) => {
    const issueId = opts.id ?? await issueIdFromSession()
    const { viewIssue, fetchIssue } = await import('./issue-view')
    if (isJson()) {
      const data = await fetchIssue(issueId)
      let github: string | null = null
      if (data.assignee?.gitHubUserId) {
        github = await resolveGitHubLogin(data.assignee.gitHubUserId)
      }
      let result: Record<string, unknown> = { ...data, assignee: data.assignee ? { ...data.assignee, gitHubUserName: github } : null }
      if (opts.fields) {
        const allowed = new Set(opts.fields.split(',').map((f) => f.trim()))
        result = Object.fromEntries(Object.entries(result).filter(([k]) => allowed.has(k)))
      }
      output(result)
    } else {
      await viewIssue(issueId, { download: opts.download, comments: opts.allComments })
    }
  })

issue
  .command('list')
  .description('List issues')
  .option('--state <name>', 'Filter by workflow state')
  .action(async (opts: { state?: string }) => {
    const issues = await linear.issues({
      filter: opts.state ? { state: { name: { eq: opts.state } } } : undefined,
      first: 50,
    })

    const items = await Promise.all(
      issues.nodes.map(async (i) => {
        const state = await i.state
        return { identifier: i.identifier, title: i.title, state: state?.name ?? null }
      }),
    )

    if (isJson()) {
      output({ issues: items })
      return
    }

    if (items.length === 0) {
      console.log('No issues found.')
      return
    }

    for (const item of items) {
      console.log(`${item.identifier}\t${item.state ?? '?'}\t${item.title}`)
    }
  })

issue
  .command('move')
  .description('Move issue to workflow state')
  .argument('<state-name>')
  .option('--id <issue-id>', 'Issue ID (inferred from LINEAR_AGENT_SESSION_ID if not set)')
  .action(async (stateName: string, opts: { id?: string }) => {
    const issueId = opts.id ?? await issueIdFromSession()
    const issue = await linear.issue(issueId)
    const team = await issue.team
    if (!team) {
      fail('TEAM_NOT_FOUND', "Could not resolve issue's team")
    }

    const states = await team.states()
    const target = states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase())
    if (!target) {
      const available = states.nodes.map((s) => s.name)
      fail('STATE_NOT_FOUND', `State "${stateName}" not found`, { available })
    }

    await linear.updateIssue(issue.id, { stateId: target.id })
    if (isJson()) {
      output({ identifier: issue.identifier, state: target.name })
    } else {
      console.log(`Moved ${issue.identifier} to "${target.name}"`)
    }
  })

issue
  .command('comment')
  .description('Post a comment on an issue')
  .argument('<body>')
  .option('--id <issue-id>', 'Issue ID (inferred from LINEAR_AGENT_SESSION_ID if not set)')
  .action(async (body: string, opts: { id?: string }) => {
    const issueId = opts.id ?? await issueIdFromSession()
    const issue = await linear.issue(issueId)
    const payload = await linear.createComment({ issueId: issue.id, body })
    if (isJson()) {
      output({ identifier: issue.identifier, commentId: payload.commentId })
    } else {
      console.log(`Comment posted on ${issue.identifier}`)
    }
  })

type IssueUpdateOpts = {
  id?: string
  dryRun?: boolean
  parent?: string
  title?: string
  description?: string
  assignee?: string
  state?: string
  priority?: string
  project?: string
  dueDate?: string
  estimate?: string
  addLabels?: string
  removeLabels?: string
}

issue
  .command('update')
  .description('Update issue fields')
  .option('--id <issue-id>', 'Issue ID (inferred from LINEAR_AGENT_SESSION_ID if not set)')
  .option('--dry-run', 'Validate and resolve all fields without applying changes')
  .option('--parent <identifier>', 'Set parent issue (identifier like TEAM-123, or "null" to remove)')
  .option('--title <title>', 'Update issue title')
  .option('--description <text>', 'Update issue description (markdown)')
  .option('--assignee <name>', 'Assign to user by name, or "null" to unassign')
  .option('--state <name>', 'Move to workflow state')
  .option('--priority <n>', 'Set priority (0=none, 1=urgent, 2=high, 3=normal, 4=low)')
  .option('--project <name>', 'Set project by name, or "null" to remove')
  .option('--due-date <date>', 'Set due date (YYYY-MM-DD), or "null" to remove')
  .option('--estimate <points>', 'Set estimate points, or "null" to remove')
  .option('--add-labels <names>', 'Add labels (comma-separated names)')
  .option('--remove-labels <names>', 'Remove labels (comma-separated names)')
  .action(async (opts: IssueUpdateOpts) => {
    const issueId = opts.id ?? (await issueIdFromSession())
    const issueObj = await linear.issue(issueId)
    const input: Record<string, unknown> = {}
    const summary: Record<string, unknown> = {}

    if (opts.parent !== undefined) {
      if (opts.parent.toLowerCase() === 'null') {
        input.parentId = null
        summary.parent = null
      } else {
        input.parentId = opts.parent
        summary.parent = opts.parent
      }
    }

    if (opts.title !== undefined) {
      input.title = opts.title
      summary.title = opts.title
    }

    if (opts.description !== undefined) {
      input.description = opts.description
      summary.description = opts.description
    }

    if (opts.assignee !== undefined) {
      if (opts.assignee.toLowerCase() === 'null') {
        input.assigneeId = null
        summary.assignee = null
      } else {
        const result = await linear.query<{ users: { nodes: { id: string; name: string; displayName: string }[] } }>(
          USER_QUERY,
          { name: opts.assignee },
        )
        const match = result.users.nodes[0]
        if (!match) fail('USER_NOT_FOUND', `No user found matching "${opts.assignee}"`)
        input.assigneeId = match.id
        summary.assignee = match.displayName
      }
    }

    if (opts.state !== undefined) {
      const team = await issueObj.team
      if (!team) fail('TEAM_NOT_FOUND', "Could not resolve issue's team")
      const states = await team.states()
      const target = states.nodes.find((s) => s.name.toLowerCase() === opts.state!.toLowerCase())
      if (!target) {
        const available = states.nodes.map((s) => s.name)
        fail('STATE_NOT_FOUND', `State "${opts.state}" not found`, { available })
      }
      input.stateId = target.id
      summary.state = target.name
    }

    if (opts.priority !== undefined) {
      const p = parseInt(opts.priority, 10)
      if (isNaN(p) || p < 0 || p > 4) {
        fail('INVALID_PRIORITY', `Priority must be 0-4, got "${opts.priority}"`)
      }
      input.priority = p
      summary.priority = p
    }

    if (opts.project !== undefined) {
      if (opts.project.toLowerCase() === 'null') {
        input.projectId = null
        summary.project = null
      } else {
        const result = await linear.query<{ projects: { nodes: { id: string; name: string }[] } }>(
          `query FindProject($name: String!) {
            projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) {
              nodes { id name }
            }
          }`,
          { name: opts.project },
        )
        const match = result.projects.nodes[0]
        if (!match) fail('PROJECT_NOT_FOUND', `No project found matching "${opts.project}"`)
        input.projectId = match.id
        summary.project = match.name
      }
    }

    if (opts.dueDate !== undefined) {
      if (opts.dueDate.toLowerCase() === 'null') {
        input.dueDate = null
        summary.dueDate = null
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.dueDate)) {
          fail('INVALID_DATE', `Due date must be YYYY-MM-DD, got "${opts.dueDate}"`)
        }
        input.dueDate = opts.dueDate
        summary.dueDate = opts.dueDate
      }
    }

    if (opts.estimate !== undefined) {
      if (opts.estimate.toLowerCase() === 'null') {
        input.estimate = null
        summary.estimate = null
      } else {
        const est = parseInt(opts.estimate, 10)
        if (isNaN(est)) fail('INVALID_ESTIMATE', `Estimate must be a number, got "${opts.estimate}"`)
        input.estimate = est
        summary.estimate = est
      }
    }

    if (opts.addLabels !== undefined) {
      const labelNames = opts.addLabels.split(',').map((l) => l.trim()).filter(Boolean)
      const allLabels = await resolveTeamLabels(issueObj)
      const ids: string[] = []
      const names: string[] = []
      for (const name of labelNames) {
        const label = allLabels.find((l) => l.name.toLowerCase() === name.toLowerCase())
        if (!label) {
          const available = allLabels.map((l) => l.name)
          fail('LABEL_NOT_FOUND', `Label "${name}" not found`, { available })
        }
        ids.push(label.id)
        names.push(label.name)
      }
      input.addedLabelIds = ids
      summary.addedLabels = names
    }

    if (opts.removeLabels !== undefined) {
      const labelNames = opts.removeLabels.split(',').map((l) => l.trim()).filter(Boolean)
      const allLabels = await resolveTeamLabels(issueObj)
      const ids: string[] = []
      const names: string[] = []
      for (const name of labelNames) {
        const label = allLabels.find((l) => l.name.toLowerCase() === name.toLowerCase())
        if (!label) {
          const available = allLabels.map((l) => l.name)
          fail('LABEL_NOT_FOUND', `Label "${name}" not found`, { available })
        }
        ids.push(label.id)
        names.push(label.name)
      }
      input.removedLabelIds = ids
      summary.removedLabels = names
    }

    if (Object.keys(input).length === 0) {
      fail('NO_FIELDS', 'No fields to update — pass at least one option (e.g. --title, --parent, --priority)')
    }

    if (opts.dryRun) {
      if (isJson()) {
        output({ identifier: issueObj.identifier, dryRun: true, resolved: summary })
      } else {
        const parts = Object.entries(summary).map(([k, v]) => `${k}: ${v ?? 'removed'}`)
        console.log(`Dry run for ${issueObj.identifier} — ${parts.join(', ')}`)
      }
      return
    }

    await linear.updateIssue(issueObj.id, input)

    if (isJson()) {
      output({ identifier: issueObj.identifier, updated: summary })
    } else {
      const parts = Object.entries(summary).map(([k, v]) => `${k}: ${v ?? 'removed'}`)
      console.log(`Updated ${issueObj.identifier} — ${parts.join(', ')}`)
    }
  })

async function resolveTeamLabels(issueObj: { team: Promise<{ id: string } | undefined> }): Promise<{ id: string; name: string }[]> {
  const team = await issueObj.team
  if (!team) fail('TEAM_NOT_FOUND', "Could not resolve issue's team")
  // Fetch both team-specific labels and workspace-level labels (team is null)
  const result = await linear.query<{
    issueLabels: { nodes: { id: string; name: string }[] }
  }>(
    `query FindLabels($teamId: ID!) {
      issueLabels(
        filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }
        first: 250
      ) {
        nodes { id name }
      }
    }`,
    { teamId: team.id },
  )
  return result.issueLabels.nodes
}

async function issueIdFromSession(): Promise<string> {
  const sessionId = process.env.LINEAR_AGENT_SESSION_ID
  if (!sessionId) {
    fail('MISSING_ISSUE_ID', 'No issue ID provided and LINEAR_AGENT_SESSION_ID is not set')
  }
  const session = await linear.agentSession(sessionId)
  const issueId = session.issueId
  if (!issueId) {
    fail('MISSING_ISSUE_ID', `Session ${sessionId} is not associated with an issue`)
  }
  return issueId
}

function getSessionId(opts: { id?: string }): string {
  const sessionId = opts.id ?? process.env.LINEAR_AGENT_SESSION_ID
  if (!sessionId) {
    fail('MISSING_SESSION_ID', 'Session ID required — pass --id <id> or set LINEAR_AGENT_SESSION_ID')
  }
  return sessionId
}

const session = program
  .command('session')
  .description('Manage agent session')
  .option('--id <id>', 'Linear agent session ID (or LINEAR_AGENT_SESSION_ID env var)')

session
  .command('add-url')
  .description('Add external URL to session')
  .argument('<url>')
  .argument('[label]')
  .action(async (url: string, label?: string) => {
    const sessionId = getSessionId(session.opts())
    await linear.updateAgentSession(sessionId, {
      addedExternalUrls: [{ label: label ?? '', url }],
    })
    if (isJson()) {
      output({ url, label: label ?? '' })
    } else {
      console.log(`URL added: ${url}`)
    }
  })

const ACTIVITY_TYPES = ['thought', 'action', 'error', 'response', 'elicitation'] as const
const ActivityTypeEnum = z.enum(ACTIVITY_TYPES)

session
  .command('activity')
  .description('Emit an activity')
  .argument('<type>', `Activity type (${ACTIVITY_TYPES.join('|')})`)
  .argument('<body>')
  .action(async (type: string, body: string) => {
    const parsed = ActivityTypeEnum.safeParse(type)
    if (!parsed.success) {
      fail('INVALID_ACTIVITY_TYPE', `Invalid activity type: ${type}`, { validTypes: [...ACTIVITY_TYPES] })
    }

    const sessionId = getSessionId(session.opts())
    await linear.createAgentActivity({
      agentSessionId: sessionId,
      content: { type: parsed.data, body },
    })
    if (isJson()) {
      output({ type: parsed.data, sessionId })
    } else {
      console.log(`Activity emitted: ${type}`)
    }
  })

program
  .command('graphql')
  .description('Execute a raw GraphQL query')
  .argument('<query>')
  .option('-v, --variables <json>', 'Variables as JSON string')
  .action(async (query: string, opts: { variables?: string }) => {
    let variables: unknown
    if (opts.variables) {
      try {
        variables = JSON.parse(opts.variables)
      } catch {
        fail('INVALID_JSON', `Failed to parse --variables as JSON: ${opts.variables}`)
      }
    }
    const result = await linear.query(query, variables)
    if (isJson()) {
      output({ data: result })
    } else {
      console.log(JSON.stringify(result, null, 2))
    }
  })

type LinearUser = {
  name: string
  displayName: string
  email: string
  gitHubUserId: string | null
}

const USER_QUERY = `query FindUser($name: String!) {
  users(filter: { or: [
    { displayName: { eqIgnoreCase: $name } },
    { name: { eqIgnoreCase: $name } }
  ] }) { nodes { name displayName email gitHubUserId } }
}`

program
  .command('user')
  .description('Look up a Linear user and their linked GitHub account')
  .argument('<name>', 'Linear display name or username to search for')
  .action(async (name: string) => {
    const result = await linear.query<{ users: { nodes: LinearUser[] } }>(USER_QUERY, { name })

    const match = result.users.nodes[0]
    if (!match) {
      fail('USER_NOT_FOUND', `No user found matching "${name}"`)
    }

    const github = match.gitHubUserId ? await resolveGitHubLogin(match.gitHubUserId) : null

    if (isJson()) {
      output({ ...match, gitHubUserName: github })
      return
    }

    console.log(`Name:    ${match.name}`)
    console.log(`Linear:  ${match.displayName}`)
    console.log(`Email:   ${match.email}`)
    const githubLabel =
      github ?? (match.gitHubUserId ? `(id: ${match.gitHubUserId}, could not resolve username)` : '(not linked)')
    console.log(`GitHub:  ${githubLabel}`)
  })

program
  .command('upload')
  .description('Upload a file to Linear and print the asset URL')
  .argument('<file>', 'Path to the file to upload')
  .action(async (filePath: string) => {
    const file = Bun.file(filePath)

    if (!(await file.exists())) {
      fail('FILE_NOT_FOUND', `File not found: ${filePath}`)
    }

    const filename = filePath.split('/').pop()!
    const contentType = file.type
    const fileBuffer = await file.arrayBuffer()

    console.error(`Uploading ${filename} (${file.size} bytes, ${contentType})...`)

    const result = await linear.query<{
      fileUpload: {
        success: boolean
        uploadFile: {
          uploadUrl: string
          assetUrl: string
          headers: Array<{ key: string; value: string }>
        }
      }
    }>(
      `mutation FileUpload($size: Int!, $contentType: String!, $filename: String!) {
        fileUpload(size: $size, contentType: $contentType, filename: $filename) {
          success
          uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { size: file.size, contentType, filename },
    )

    if (!result.fileUpload.success) {
      fail('UPLOAD_FAILED', 'fileUpload mutation failed')
    }

    const { uploadUrl, assetUrl, headers } = result.fileUpload.uploadFile

    const putHeaders = new Headers()
    putHeaders.set('Content-Type', contentType)
    putHeaders.set('Cache-Control', 'public, max-age=31536000')
    for (const { key, value } of headers) {
      putHeaders.set(key, value)
    }

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: putHeaders,
      body: fileBuffer,
    })

    if (!putResponse.ok) {
      fail('UPLOAD_FAILED', `Upload failed (${putResponse.status})`)
    }

    if (isJson()) {
      output({ assetUrl, filename })
    } else {
      console.log(assetUrl)
    }
  })

const REPO = 'membranehq/linear-agent'

function getBinaryName(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `linear-agent-${platform}-${arch}${ext}`
}

program
  .command('update')
  .description('Update to the latest release')
  .action(async () => {
    const current = version

    const releaseResp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!releaseResp.ok) {
      fail('UNEXPECTED_ERROR', `Failed to check for updates (${releaseResp.status})`)
    }
    const release = (await releaseResp.json()) as { tag_name: string }
    const latest = release.tag_name.replace(/^v/, '')

    if (current === latest) {
      if (isJson()) {
        output({ version: current, updated: false })
      } else {
        console.log(`Already up to date ${chalk.dim(`(${current})`)}`)
      }
      return
    }

    const binPath = process.execPath
    const tmpPath = `${binPath}.tmp`
    const asset = getBinaryName()
    const url = `https://github.com/${REPO}/releases/latest/download/${asset}`
    if (!isJson()) {
      console.log(`Updating ${chalk.dim(current)} → ${chalk.green(latest)}...`)
    }
    const resp = await fetch(url, { redirect: 'follow' })
    if (!resp.ok) {
      fail('UNEXPECTED_ERROR', `Failed to download (${resp.status})`)
    }
    await Bun.write(tmpPath, resp)
    chmodSync(tmpPath, 0o755)
    renameSync(tmpPath, binPath)
    if (isJson()) {
      output({ version: latest, updated: true })
    } else {
      console.log(`Updated to ${chalk.green(latest)}`)
    }
  })

program.parseAsync().catch((err) => {
  fail('UNEXPECTED_ERROR', err.message ?? String(err))
})

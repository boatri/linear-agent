#!/usr/bin/env bun
import { Command } from 'commander'
import { linear } from './linear'
import { resolveGitHubLogin } from './github'
import { Watcher } from './claude/watcher'
import { acquireLock } from './claude/lock'

const program = new Command().name('linear-agent').description('Stream Claude Code sessions to Linear')

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
  .argument('<issue-id>')
  .option('--no-download', 'Keep remote URLs instead of downloading files')
  .option('--comments', 'Expand all comment replies')
  .option('--json', 'Output raw JSON')
  .action(async (issueId: string, opts: { download?: boolean; comments?: boolean; json?: boolean }) => {
    const { viewIssue, fetchIssue } = await import('./issue-view')
    if (opts.json) {
      const data = await fetchIssue(issueId)
      let github: string | null = null
      if (data.assignee?.gitHubUserId) {
        github = await resolveGitHubLogin(data.assignee.gitHubUserId)
      }
      console.log(JSON.stringify({ ...data, assignee: data.assignee ? { ...data.assignee, gitHubUserName: github } : null }, null, 2))
    } else {
      await viewIssue(issueId, opts)
    }
  })

issue
  .command('list')
  .description('List issues')
  .option('--state <name>', 'Filter by workflow state')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { state?: string; json?: boolean }) => {
    const issues = await linear.issues({
      filter: opts.state ? { state: { name: { eq: opts.state } } } : undefined,
      first: 50,
    })

    if (opts.json) {
      const items = await Promise.all(
        issues.nodes.map(async (i) => {
          const state = await i.state
          return { identifier: i.identifier, title: i.title, state: state?.name ?? null }
        }),
      )
      console.log(JSON.stringify(items, null, 2))
      return
    }

    if (issues.nodes.length === 0) {
      console.log('No issues found.')
      return
    }

    for (const issue of issues.nodes) {
      const state = await issue.state
      console.log(`${issue.identifier}\t${state?.name ?? '?'}\t${issue.title}`)
    }
  })

issue
  .command('move')
  .description('Move issue to workflow state')
  .argument('<issue-id>')
  .argument('<state-name>')
  .action(async (issueId: string, stateName: string) => {
    const issue = await linear.issue(issueId)
    const team = await issue.team
    if (!team) {
      console.error("Error: Could not resolve issue's team")
      process.exit(1)
    }

    const states = await team.states()
    const target = states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase())
    if (!target) {
      const available = states.nodes.map((s) => s.name).join(', ')
      console.error(`Error: State "${stateName}" not found. Available: ${available}`)
      process.exit(1)
    }

    await linear.updateIssue(issue.id, { stateId: target.id })
    console.log(`Moved ${issue.identifier} to "${target.name}"`)
  })

issue
  .command('comment')
  .description('Post a comment on an issue')
  .argument('<issue-id>')
  .argument('<body>')
  .action(async (issueId: string, body: string) => {
    const issue = await linear.issue(issueId)
    await linear.createComment({ issueId: issue.id, body })
    console.log(`Comment posted on ${issue.identifier}`)
  })

function getSessionId(opts: { id?: string }): string {
  const sessionId = opts.id ?? process.env.LINEAR_AGENT_SESSION_ID
  if (!sessionId) {
    console.error('Error: Session ID required — pass --id <id> or set LINEAR_AGENT_SESSION_ID')
    process.exit(1)
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
    console.log(`URL added: ${url}`)
  })

const ACTIVITY_TYPES = ['thought', 'action', 'error', 'response', 'elicitation'] as const

session
  .command('activity')
  .description('Emit an activity')
  .argument('<type>', `Activity type (${ACTIVITY_TYPES.join('|')})`)
  .argument('<body>')
  .action(async (type: string, body: string) => {
    if (!ACTIVITY_TYPES.includes(type as (typeof ACTIVITY_TYPES)[number])) {
      console.error(`Error: Invalid activity type: ${type}. Must be one of: ${ACTIVITY_TYPES.join(', ')}`)
      process.exit(1)
    }

    const sessionId = getSessionId(session.opts())
    await linear.createAgentActivity({
      agentSessionId: sessionId,
      content: { type, body },
    })
    console.log(`Activity emitted: ${type}`)
  })

program
  .command('graphql')
  .description('Execute a raw GraphQL query')
  .argument('<query>')
  .option('-v, --variables <json>', 'Variables as JSON string')
  .action(async (query: string, opts: { variables?: string }) => {
    const variables = opts.variables ? JSON.parse(opts.variables) : undefined
    const result = await linear.query(query, variables)
    console.log(JSON.stringify(result, null, 2))
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
  .option('--json', 'Output raw JSON')
  .action(async (name: string, opts: { json?: boolean }) => {
    const result = await linear.query<{ users: { nodes: LinearUser[] } }>(USER_QUERY, { name })

    const match = result.users.nodes[0]
    if (!match) {
      console.error(`Error: No user found matching "${name}"`)
      process.exit(1)
    }

    const github = match.gitHubUserId ? await resolveGitHubLogin(match.gitHubUserId) : null

    if (opts.json) {
      console.log(JSON.stringify({ ...match, gitHubUserName: github }, null, 2))
      return
    }

    console.log(`Name:    ${match.name}`)
    console.log(`Linear:  ${match.displayName}`)
    console.log(`Email:   ${match.email}`)
    const githubLabel = github
      ?? (match.gitHubUserId ? `(id: ${match.gitHubUserId}, could not resolve username)` : '(not linked)')
    console.log(`GitHub:  ${githubLabel}`)
  })

const REPO = 'boatri/linear-agent'

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
    const binPath = process.execPath
    const asset = getBinaryName()
    const url = `https://github.com/${REPO}/releases/latest/download/${asset}`
    console.log(`Downloading ${asset}...`)
    const resp = await fetch(url, { redirect: 'follow' })
    if (!resp.ok) {
      console.error(`Error: Failed to download (${resp.status})`)
      process.exit(1)
    }
    await Bun.write(binPath, resp)
    const { chmodSync } = await import('fs')
    chmodSync(binPath, 0o755)
    console.log(`Updated ${binPath}`)
  })

program.parseAsync().catch((err) => {
  console.error(`Error: ${err.message ?? err}`)
  process.exit(1)
})

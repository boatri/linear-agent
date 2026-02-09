#!/usr/bin/env bun
import { Command } from 'commander'
import { linear } from './linear'
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
  .action(async (issueId: string) => {
    const issue = await linear.issue(issueId)
    const state = await issue.state
    const assignee = await issue.assignee

    console.log(`${issue.identifier}: ${issue.title}`)
    console.log(`State: ${state?.name ?? 'Unknown'}`)
    console.log(`Assignee: ${assignee?.name ?? 'Unassigned'}`)
    console.log(`Priority: ${issue.priority}`)
    if (issue.description) {
      console.log(`\nDescription:\n${issue.description}`)
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

---
name: linear-agent
description: Interact with Linear to move issues, update sessions, and post comments.
allowed-tools: Bash(bun run *cli.ts *)
---

# Linear Agent CLI

Use this skill to interact with Linear issues and agent sessions. The CLI is available at `bun run /path/to/claude-linear-bridge/src/cli.ts`.

## Environment Variables

These are pre-configured in your environment:
- `LINEAR_CLIENT_ID` — OAuth app client ID
- `LINEAR_CLIENT_SECRET` — OAuth app client secret
- `LINEAR_AGENT_SESSION_ID` — Current agent session ID (for session commands)

## Available Commands

### Issue Commands

```bash
# View issue details (title, state, description, assignee)
bun run src/cli.ts issue view LIN-123

# List issues, optionally filtered by state
bun run src/cli.ts issue list
bun run src/cli.ts issue list --state "In Progress"

# Move issue to a workflow state
bun run src/cli.ts issue move LIN-123 "In Review"

# Post a comment on an issue
bun run src/cli.ts issue comment LIN-123 "Implementation complete. See PR #42."
```

### Session Commands

```bash
# Update session plan items
bun run src/cli.ts session update-plan '[{"text":"Investigate bug","completed":true},{"text":"Write fix","completed":false}]'

# Add an external URL (e.g. PR link) to the session
bun run src/cli.ts session add-url "Pull Request" "https://github.com/org/repo/pull/42"

# Manually emit an activity
bun run src/cli.ts session activity thought "Investigating the root cause"
```

## Typical Workflows

### After Creating a Pull Request

1. Add the PR URL to the session:
   ```bash
   bun run src/cli.ts session add-url "Pull Request" "https://github.com/org/repo/pull/42"
   ```
2. Move the issue to review:
   ```bash
   bun run src/cli.ts issue move LIN-123 "In Review"
   ```

### On Completion

1. Move the issue to done:
   ```bash
   bun run src/cli.ts issue move LIN-123 "Done"
   ```
2. Post a summary comment:
   ```bash
   bun run src/cli.ts issue comment LIN-123 "Implementation complete. See PR #42."
   ```

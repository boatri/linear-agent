# linear-agent

Provides transparency into Claude Code sessions by streaming activities to Linear in real-time. Tails Claude Code's native JSONL session files and emits structured activities (thoughts, actions, responses, errors) to a Linear agent session.

## How It Works

Claude Code writes every conversation event (thinking, text, tool use, tool results) as JSONL lines to `~/.claude/projects/*/SESSION_ID.jsonl`. The watcher tails this file and maps each entry to a Linear agent activity.

```
Watcher (tails JSONL files)
  → Parser (line → typed entry)
  → Emitter (entry → Linear activity + plan updates)
  → Linear API (createAgentActivity, updateAgentSession)
```

The watcher automatically discovers linked successor sessions (e.g. when Claude resumes with a new session file) and tails them alongside the original.

### Event Mapping

| JSONL Entry                    | Linear Activity       | Content                      |
|--------------------------------|-----------------------|------------------------------|
| `assistant` + thinking         | `thought` (ephemeral) | Thinking text                |
| `assistant` + text             | `response`            | Response text                |
| `assistant` + tool_use         | `action` (ephemeral)  | Tool name + params           |
| `user` + tool_result (success) | `action`              | Completed action with result |
| `user` + tool_result (error)   | `error`               | Error message                |
| `queue-operation` (completed)  | `action`              | Background command summary   |
| `queue-operation` (failed)     | `error`               | Background command failure   |
| `summary`                      | `thought`             | Context summary              |

### Plan Tracking

When Claude uses task/todo tools, the watcher syncs them to Linear's agent plan:

| Tool         | Behavior                                      |
|--------------|-----------------------------------------------|
| `TaskCreate` | Adds task to plan (parses ID from result)     |
| `TaskUpdate` | Updates task status or removes if deleted     |
| `TodoWrite`  | Replaces entire plan (full list replacement)  |

Status mapping: `pending` → `pending`, `in_progress` → `inProgress`, `completed` → `completed`, `deleted` → `canceled`.

## Setup

```bash
bun install
```

Required environment variables:
- `LINEAR_CLIENT_ID` — Linear OAuth app client ID
- `LINEAR_CLIENT_SECRET` — Linear OAuth app client secret

## Usage

### Watching a Session

The session ID is shared between Claude Code and Linear — the same UUID is used for both `--session-id` flags.

```bash
SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

# Start watcher before Claude, in background
bun run src/cli.ts watch --session-id $SESSION_ID &
WATCHER_PID=$!

# Run Claude with the same session ID
claude -p "work on this" --session-id $SESSION_ID

# Clean up
kill $WATCHER_PID 2>/dev/null; wait $WATCHER_PID
```

The watcher:
- Polls for the JSONL file to appear (it may not exist yet when the watcher starts)
- Discovers and tails linked successor session files automatically
- Tails indefinitely with minimal resource usage when idle
- Handles SIGTERM/SIGINT gracefully (flushes remaining lines, persists cursor)
- Supports resume via cursor files (`/tmp/claude-linear-cursor-{sessionId}.json`)

### CLI Commands

The CLI provides direct commands for managing Linear issues and sessions:

```bash
# Issues
bun run src/cli.ts issue view LIN-123
bun run src/cli.ts issue list --state "In Progress"
bun run src/cli.ts issue move LIN-123 "In Review"
bun run src/cli.ts issue comment LIN-123 "Done. See PR #42."

# Sessions (pass --id or set LINEAR_AGENT_SESSION_ID env var)
bun run src/cli.ts session --id $SESSION_ID update-plan '[{"content":"Fix bug","status":"completed"}]'
bun run src/cli.ts session --id $SESSION_ID add-url "Pull Request" "https://github.com/org/repo/pull/42"
bun run src/cli.ts session --id $SESSION_ID activity thought "Investigating root cause"
bun run src/cli.ts session --id $SESSION_ID activity elicitation "Which auth provider should I use?"
```

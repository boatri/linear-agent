---
name: linear-agent
description: Interact with Linear to move issues, update sessions, and post comments.
allowed-tools: Bash(linear-agent *)
---

# Linear Agent CLI

Use this skill to interact with Linear issues and agent sessions via the `linear-agent` command.

## Environment Variables

These are pre-configured in your environment:
- `MEMBRANE_WORKSPACE_KEY` — Membrane workspace key
- `MEMBRANE_WORKSPACE_SECRET` — Membrane workspace secret
- `MEMBRANE_CUSTOMER_ID` — Membrane customer ID
- `LINEAR_AGENT_SESSION_ID` — Current agent session ID (for session commands). Can also be passed as `session --id <id>`.

## Available Commands

### Issue Commands

```bash
# View issue details (title, state, description, assignee)
linear-agent issue view LIN-123

# List issues, optionally filtered by state
linear-agent issue list
linear-agent issue list --state "In Progress"

# Move issue to a workflow state
linear-agent issue move LIN-123 "In Review"

# Post a comment on an issue
linear-agent issue comment LIN-123 "Implementation complete. See PR #42."
```

### Session Commands

```bash
# Add an external URL (e.g. PR link) to the session
linear-agent session add-url "Pull Request" "https://github.com/org/repo/pull/42"

# Manually emit an activity
linear-agent session activity thought "Investigating the root cause"

# Ask the user a question through Linear (they'll see it in the Linear UI)
linear-agent session activity elicitation "Which authentication provider should I use — OAuth2 or SAML?"
```

## Asking for Clarification via Linear

If you are **blocked on a decision** that prevents you from making meaningful progress, use elicitation to ask the user through Linear:

```bash
linear-agent session activity elicitation "Your question here"
```

Use this when:
- A requirement is ambiguous and you cannot make a reasonable default choice
- You need to choose between fundamentally different approaches
- The task description is missing critical information

Do **not** use this for minor decisions you can make yourself. Prefer making reasonable assumptions and documenting them over blocking on every small choice.

## Typical Workflows

### After Creating a Pull Request

1. Add the PR URL to the session:
   ```bash
   linear-agent session add-url "Pull Request" "https://github.com/org/repo/pull/42"
   ```
2. Move the issue to review:
   ```bash
   linear-agent issue move LIN-123 "In Review"
   ```

### On Completion

1. Move the issue to done:
   ```bash
   linear-agent issue move LIN-123 "Done"
   ```
2. Post a summary comment:
   ```bash
   linear-agent issue comment LIN-123 "Implementation complete. See PR #42."
   ```

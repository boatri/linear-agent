---
name: linear-agent
description: Interact with Linear to move issues and update sessions
allowed-tools: Bash(linear-agent *)
---

# Linear Agent CLI

You're an agent that works alongside humans in Linear. Use `linear-agent` to interact with issues and agent sessions there.
Everything that happens in the session is streamed to Linear automatically (so users can see your responses, tool uses etc.).
At the same time, there are still things that you need to do to make the user experience better.

## View issue details

```bash
linear-agent issue view LIN-123
```

## Asking for Clarification

If you are blocked on a decision that prevents you from making meaningful progress, use `elicitation` to ask the user through Linear:

```bash
linear-agent session activity elicitation "Your question here"
```

Use this when:
- A requirement is ambiguous, and you cannot make a reasonable default choice
- You need to choose between fundamentally different approaches
- The task description is missing critical information

Do not use this for minor decisions you can make yourself.
Prefer making reasonable assumptions and documenting them over blocking on every small choice.

## After Creating a Pull Request

1. Add the PR URL to the session:
   ```bash
   linear-agent session add-url "https://github.com/org/repo/pull/42"
   ```
2. Move the issue to review:
   ```bash
   linear-agent issue move LIN-123 "In Review"
   ```

For other available commands, run `linear-agent --help`.

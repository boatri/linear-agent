export interface ToolMapped {
  action: string
  parameter: string
  result?: string
}

type ToolMapper = (input: Record<string, unknown>, result?: string) => ToolMapped

function withResult(base: { action: string; parameter: string }, result?: string): ToolMapped {
  if (result) return { ...base, result }
  return base
}

function safeString(value: unknown): string {
  return String(value ?? '')
}

function codeBlock(content: string, lang: string): string {
  return '```' + lang + '\n' + content + '\n```'
}

function isJson(str: string): boolean {
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

function formatBashResult(command: string, result: string): string {
  if (/^git\s+diff\b/.test(command)) return codeBlock(result, 'diff')
  if (isJson(result)) return codeBlock(result, 'json')
  return result
}

function formatDiff(oldStr: string, newStr: string): string | undefined {
  if (!oldStr && !newStr) return undefined
  const lines = [
    ...oldStr.split('\n').map((l) => `- ${l}`),
    ...newStr.split('\n').map((l) => `+ ${l}`),
  ]
  return codeBlock(lines.join('\n'), 'diff')
}

export const TOOL_MAPPING: Record<string, ToolMapper> = {
  Bash: (input, result) => {
    const command = safeString(input.command)
    const formatted = result ? formatBashResult(command, result) : undefined
    return withResult({ action: 'Ran command', parameter: command }, formatted)
  },
  Edit: (input) => {
    const diff = formatDiff(safeString(input.old_string), safeString(input.new_string))
    return withResult({ action: 'Edited file', parameter: safeString(input.file_path) }, diff)
  },
  Write: (input) => ({ action: 'Created file', parameter: safeString(input.file_path) }),
  Read: (input) => ({ action: 'Read file', parameter: safeString(input.file_path) }),
  Glob: (input, result) => {
    let parameter = safeString(input.pattern)
    if (input.path) parameter += ` in ${input.path}`
    return withResult({ action: 'Searched files', parameter }, result)
  },
  Grep: (input, result) => {
    let parameter = safeString(input.pattern)
    if (input.path) parameter += ` in ${input.path}`
    if (input.glob) parameter += ` (${input.glob})`
    return withResult({ action: 'Searched for pattern', parameter }, result)
  },
  Task: (input, result) => {
    const desc = safeString(input.description)
    if (!result) return { action: 'Delegated subtask', parameter: desc }

    const responseText = result.replace(/agentId:.*\n?/g, '').replace(/<usage>[\s\S]*?<\/usage>/g, '').trim()
    return withResult({ action: 'Delegated subtask', parameter: desc }, responseText || undefined)
  },
  WebFetch: (input, result) => withResult({ action: 'Fetched URL', parameter: safeString(input.url) }, result),
  WebSearch: (input) => ({ action: 'Web search', parameter: safeString(input.query) }),
  TaskCreate: (input) => ({ action: 'Created task', parameter: safeString(input.subject) }),
  TaskUpdate: (input) => ({ action: 'Updated task', parameter: safeString(input.taskId) }),
  Skill: (input) => ({ action: 'Invoked skill', parameter: safeString(input.skill) }),
  AskUserQuestion: (input) => ({
    action: 'Asked user', // Shouldn't happen normally, will be handled though elicitation session activity
    parameter: safeString((input.questions as Array<{ question: string }> | undefined)?.[0]?.question),
  }),
  NotebookEdit: (input) => ({ action: 'Edited notebook', parameter: safeString(input.notebook_path) }),
}

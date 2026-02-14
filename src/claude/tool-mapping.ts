export const TOOL_MAPPING: Record<
  string,
  (input: Record<string, unknown>, result?: string) => { action: string; parameter: string; result?: string }
> = {
  Bash: (input, result) => ({
    action: 'Ran command',
    parameter: String(input.command ?? ''),
    ...(result ? { result } : {}),
  }),
  Edit: (input) => ({
    action: 'Edited file',
    parameter: String(input.file_path ?? ''),
  }),
  Write: (input) => ({
    action: 'Created file',
    parameter: String(input.file_path ?? ''),
  }),
  Read: (input) => ({
    action: 'Read file',
    parameter: String(input.file_path ?? ''),
  }),
  Glob: (input, result) => {
    let parameter = String(input.pattern ?? '')
    if (input.path) parameter += ` in ${input.path}`
    return { action: 'Searched files', parameter, ...(result ? { result } : {}) }
  },
  Grep: (input, result) => {
    let parameter = String(input.pattern ?? '')
    if (input.path) parameter += ` in ${input.path}`
    if (input.glob) parameter += ` (${input.glob})`
    return { action: 'Searched for pattern', parameter, ...(result ? { result } : {}) }
  },
  Task: (input, result) => {
    const desc = String(input.description ?? '')
    if (!result) return { action: 'Delegated subtask', parameter: desc }

    const responseText = result.replace(/agentId:.*\n?/g, '').replace(/<usage>[\s\S]*?<\/usage>/g, '').trim()
    return { action: 'Delegated subtask', parameter: desc, ...(responseText ? { result: responseText } : {}) }
  },
  WebFetch: (input, result) => ({
    action: 'Fetched URL',
    parameter: String(input.url ?? ''),
    ...(result ? { result } : {}),
  }),
  WebSearch: (input) => ({
    action: 'Web search',
    parameter: String(input.query ?? ''),
  }),
  TaskCreate: (input) => ({
    action: 'Created task',
    parameter: String(input.subject ?? ''),
  }),
  TaskUpdate: (input) => ({
    action: 'Updated task',
    parameter: String(input.taskId ?? ''),
  }),
  Skill: (input) => ({
    action: 'Invoked skill',
    parameter: String(input.skill ?? ''),
  }),
  AskUserQuestion: (input) => ({
    action: 'Asked user',
    parameter: String((input.questions as Array<{ question: string }> | undefined)?.[0]?.question ?? ''),
  }),
  NotebookEdit: (input) => ({
    action: 'Edited notebook',
    parameter: String(input.notebook_path ?? ''),
  }),
}

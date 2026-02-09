export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 3) + '...'
}

export const TOOL_MAPPING: Record<
  string,
  (input: Record<string, unknown>, result?: string) => { action: string; parameter: string; result?: string }
> = {
  Bash: (input, result) => ({
    action: 'Ran command',
    parameter: truncate(String(input.command ?? ''), 200),
    ...(result ? { result: truncate(result, 500) } : {}),
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
  Glob: (input) => ({
    action: 'Searched files',
    parameter: String(input.pattern ?? ''),
  }),
  Grep: (input) => ({
    action: 'Searched code',
    parameter: String(input.pattern ?? ''),
  }),
  Task: (input) => ({
    action: 'Delegated subtask',
    parameter: truncate(String(input.description ?? ''), 200),
  }),
  WebFetch: (input, result) => ({
    action: 'Fetched URL',
    parameter: String(input.url ?? ''),
    ...(result ? { result: truncate(result, 500) } : {}),
  }),
  WebSearch: (input) => ({
    action: 'Web search',
    parameter: truncate(String(input.query ?? ''), 200),
  }),
  TaskCreate: (input) => ({
    action: 'Created task',
    parameter: truncate(String(input.subject ?? ''), 200),
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
    parameter: truncate(String((input.questions as Array<{ question: string }> | undefined)?.[0]?.question ?? ''), 200),
  }),
  NotebookEdit: (input) => ({
    action: 'Edited notebook',
    parameter: String(input.notebook_path ?? ''),
  }),
}

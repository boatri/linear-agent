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
    parameter: String(input.description ?? ''),
  }),
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

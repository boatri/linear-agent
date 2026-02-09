export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text: string }>
  is_error?: boolean
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock

interface EntryBase {
  uuid: string
  timestamp: string
  parentUuid: string | null
  sessionId: string
}

export interface AssistantEntry extends EntryBase {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
    id: string
    model: string
  }
  requestId: string
}

export interface UserEntry extends EntryBase {
  type: 'user'
  message: {
    role: 'user'
    content: (TextBlock | ToolResultBlock)[]
  }
  toolUseResult?:
    | string
    | {
        status: string
        content: Array<{ type: string; text: string }>
        sourceToolAssistantUUID?: string
      }
  sourceToolAssistantUUID?: string
}

export interface SummaryEntry {
  type: 'summary'
  summary: string
  leafUuid: string
}

export interface ProgressEntry extends EntryBase {
  type: 'progress'
  data: unknown
}

export interface QueueOperationEntry {
  type: 'queue-operation'
  operation: string
  content?: string
  [key: string]: unknown
}

export type JournalEntry =
  | AssistantEntry
  | UserEntry
  | SummaryEntry
  | ProgressEntry
  | QueueOperationEntry
  | { type: 'file-history-snapshot'; [key: string]: unknown }
  | { type: 'system'; [key: string]: unknown }

export interface WatcherConfig {
  sessionId: string
}

export interface CursorState {
  byteOffset: number
  lineCount: number
  lastUuid: string
}

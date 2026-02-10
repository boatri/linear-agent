import type { LinearSdk } from '@linear/sdk'
import type {
  JournalEntry,
  AssistantEntry,
  UserEntry,
  SummaryEntry,
  QueueOperationEntry,
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from './types'
import { TOOL_MAPPING } from './tool-mapping'
import { RateLimiter } from '../rate-limiter'
import { PlanTracker } from './plan-tracker'
import { logger as rootLogger } from '../logger'

const logger = rootLogger.child({ module: 'emitter' })
interface PendingTool {
  name: string
  input: Record<string, unknown>
}

export class ActivityEmitter {
  private readonly sessionId: string
  private readonly rateLimiter: RateLimiter
  private readonly pendingToolUses = new Map<string, PendingTool>()
  private readonly planTracker = new PlanTracker()

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.rateLimiter = new RateLimiter({ perSecond: 2, burst: 5 })
  }

  async process(entry: JournalEntry, client: LinearSdk): Promise<void> {
    switch (entry.type) {
      case 'assistant':
        await this.processAssistant(entry, client)
        break
      case 'user':
        await this.processUser(entry, client)
        break
      case 'summary':
        await this.processSummary(entry, client)
        break
      case 'queue-operation':
        await this.processQueueOperation(entry, client)
        break
      // Skip: progress, file-history-snapshot, system
    }
  }

  private async processAssistant(entry: AssistantEntry, client: LinearSdk): Promise<void> {
    if (entry.isApiErrorMessage) {
      const text = entry.message.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
      if (text) {
        await this.emit(client, { type: 'error', body: text })
      }
      return
    }

    // Each assistant entry has a single-element content array
    const block = entry.message.content[0]
    if (!block) return

    switch (block.type) {
      case 'thinking':
        await this.emitThinking(block, client)
        break
      case 'text':
        await this.emitText(block, client)
        break
      case 'tool_use':
        await this.emitToolUse(block, client)
        break
    }
  }

  private async processUser(entry: UserEntry, client: LinearSdk): Promise<void> {
    const content = entry.message.content

    for (const block of content) {
      if (block.type === 'tool_result') {
        await this.emitToolResult(block, entry, client)
      }
      // Skip user text (prompts) — Linear shows these natively
    }
  }

  private async processSummary(entry: SummaryEntry, client: LinearSdk): Promise<void> {
    await this.emit(client, {
      type: 'thought',
      body: `Context: ${entry.summary}`,
    })
  }

  private async processQueueOperation(entry: QueueOperationEntry, client: LinearSdk): Promise<void> {
    if (entry.operation !== 'enqueue' || !entry.content) return

    const summary = entry.content.match(/<summary>(.*?)<\/summary>/s)?.[1]
    if (!summary) return // Not a task notification, just a queued user message

    const status = entry.content.match(/<status>(.*?)<\/status>/)?.[1]
    const type = status === 'failed' ? 'error' : 'action'
    await this.emit(client, { type, body: summary })
  }

  private async emitThinking(block: ThinkingBlock, client: LinearSdk): Promise<void> {
    await this.emit(client, { type: 'thought', body: block.thinking }, true)
  }

  private async emitText(block: TextBlock, client: LinearSdk): Promise<void> {
    const text = block.text.trim()
    if (!text) return
    await this.emit(client, { type: 'response', body: text })
  }

  private async emitToolUse(block: ToolUseBlock, client: LinearSdk): Promise<void> {
    this.pendingToolUses.set(block.id, { name: block.name, input: block.input })

    const mapper = TOOL_MAPPING[block.name]
    if (!mapper) return

    const mapped = mapper(block.input)
    await this.emit(
      client,
      { type: 'action', ...mapped },
      true, // ephemeral — the completed action will follow
    )
  }

  private async emitToolResult(block: ToolResultBlock, entry: UserEntry, client: LinearSdk): Promise<void> {
    const pending = this.pendingToolUses.get(block.tool_use_id)
    if (!pending) return
    this.pendingToolUses.delete(block.tool_use_id)

    const resultText = typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join('\n')

    if (!block.is_error) {
      switch (pending.name) {
        case 'TaskCreate':
          this.planTracker.handleTaskCreate(pending.input, resultText)
          await this.pushPlan(client)
          break
        case 'TaskUpdate':
          this.planTracker.handleTaskUpdate(pending.input)
          await this.pushPlan(client)
          break
        case 'TodoWrite':
          this.planTracker.handleTodoWrite(pending.input)
          await this.pushPlan(client)
          break
      }
    }

    if (block.is_error) {
      await this.emit(client, {
        type: 'error',
        body: `**${pending.name}** failed: ${resultText}`,
      })
      return
    }

    const mapper = TOOL_MAPPING[pending.name]
    if (!mapper) return

    const mapped = mapper(pending.input, resultText)
    await this.emit(client, { type: 'action', ...mapped })
  }

  private async pushPlan(client: LinearSdk): Promise<void> {
    if (!this.planTracker.hasPlan()) return
    await this.rateLimiter.acquire()
    try {
      await client.updateAgentSession(this.sessionId, {
        plan: this.planTracker.toLinearPlan(),
      })
    } catch (err) {
      logger.error({ err }, 'Failed to update plan')
    }
  }

  private async emit(
    client: LinearSdk,
    content: { type: string; body?: string; action?: string; parameter?: string; result?: string },
    ephemeral?: boolean,
  ): Promise<void> {
    await this.rateLimiter.acquire()
    try {
      await client.createAgentActivity({
        agentSessionId: this.sessionId,
        content,
        ...(ephemeral ? { ephemeral: true } : {}),
      })
    } catch (err) {
      logger.error({ err, activityType: content.type }, 'Failed to emit activity')
    }
  }
}

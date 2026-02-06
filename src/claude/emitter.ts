import type { LinearClient } from "@linear/sdk";
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
} from "./types";
import { TOOL_MAPPING, truncate } from "./tool-mapping";
import { RateLimiter } from "../rate-limiter";
import { PlanTracker } from "./plan-tracker";
import { logger as rootLogger } from "../logger";

const logger = rootLogger.child({ module: "emitter" });
const MAX_BODY_LENGTH = 10000;

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
}

export class ActivityEmitter {
  private readonly sessionId: string;
  private readonly rateLimiter: RateLimiter;
  private readonly pendingToolUses = new Map<string, PendingTool>();
  private readonly planTracker = new PlanTracker();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.rateLimiter = new RateLimiter({ perSecond: 2, burst: 5 });
  }

  async process(entry: JournalEntry, client: LinearClient): Promise<void> {
    switch (entry.type) {
      case "assistant":
        await this.processAssistant(entry, client);
        break;
      case "user":
        await this.processUser(entry, client);
        break;
      case "summary":
        await this.processSummary(entry, client);
        break;
      case "queue-operation":
        await this.processQueueOperation(entry, client);
        break;
      // Skip: progress, file-history-snapshot, system
    }
  }

  private async processAssistant(entry: AssistantEntry, client: LinearClient): Promise<void> {
    // Each assistant entry has a single-element content array
    const block = entry.message.content[0];
    if (!block) return;

    switch (block.type) {
      case "thinking":
        await this.emitThinking(block, client);
        break;
      case "text":
        await this.emitText(block, client);
        break;
      case "tool_use":
        await this.emitToolUse(block, client);
        break;
    }
  }

  private async processUser(entry: UserEntry, client: LinearClient): Promise<void> {
    const content = entry.message.content;

    for (const block of content) {
      if (block.type === "tool_result") {
        await this.emitToolResult(block, entry, client);
      }
      // Skip user text (prompts) — Linear shows these natively
    }
  }

  private async processSummary(entry: SummaryEntry, client: LinearClient): Promise<void> {
    await this.emit(client, {
      type: "thought",
      body: `Context: ${truncate(entry.summary, 2000)}`,
    });
  }

  private async processQueueOperation(
    entry: QueueOperationEntry,
    client: LinearClient,
  ): Promise<void> {
    if (entry.operation !== "enqueue" || !entry.content) return;

    const summary = entry.content.match(/<summary>(.*?)<\/summary>/s)?.[1];
    if (!summary) return; // Not a task notification, just a queued user message

    const status = entry.content.match(/<status>(.*?)<\/status>/)?.[1];
    const type = status === "failed" ? "error" : "action";
    await this.emit(client, { type, body: summary });
  }

  private async emitThinking(block: ThinkingBlock, client: LinearClient): Promise<void> {
    await this.emit(
      client,
      { type: "thought", body: truncate(block.thinking, 2000) },
      true,
    );
  }

  private async emitText(block: TextBlock, client: LinearClient): Promise<void> {
    const text = block.text.trim();
    if (!text) return;
    await this.emit(client, { type: "response", body: truncate(text, MAX_BODY_LENGTH) });
  }

  private async emitToolUse(block: ToolUseBlock, client: LinearClient): Promise<void> {
    this.pendingToolUses.set(block.id, { name: block.name, input: block.input });

    const mapper = TOOL_MAPPING[block.name];
    if (!mapper) return;

    const mapped = mapper(block.input);
    await this.emit(
      client,
      { type: "action", ...mapped },
      true, // ephemeral — the completed action will follow
    );
  }

  private async emitToolResult(
    block: ToolResultBlock,
    entry: UserEntry,
    client: LinearClient,
  ): Promise<void> {
    const pending = this.pendingToolUses.get(block.tool_use_id);
    if (!pending) return;
    this.pendingToolUses.delete(block.tool_use_id);

    const resultText =
      typeof block.content === "string"
        ? block.content
        : block.content.map((c) => c.text).join("\n");

    if (!block.is_error) {
      switch (pending.name) {
        case "TaskCreate":
          this.planTracker.handleTaskCreate(pending.input, resultText);
          await this.pushPlan(client);
          break;
        case "TaskUpdate":
          this.planTracker.handleTaskUpdate(pending.input);
          await this.pushPlan(client);
          break;
        case "TodoWrite":
          this.planTracker.handleTodoWrite(pending.input);
          await this.pushPlan(client);
          break;
      }
    }

    if (block.is_error) {
      await this.emit(client, {
        type: "error",
        body: truncate(`**${pending.name}** failed: ${resultText}`, 2000),
      });
      return;
    }

    const mapper = TOOL_MAPPING[pending.name];
    if (!mapper) return;

    const mapped = mapper(pending.input, resultText);
    await this.emit(client, { type: "action", ...mapped });
  }

  private async pushPlan(client: LinearClient): Promise<void> {
    if (!this.planTracker.hasPlan()) return;
    await this.rateLimiter.acquire();
    try {
      await client.updateAgentSession(this.sessionId, {
        plan: this.planTracker.toLinearPlan(),
      });
    } catch (err) {
      logger.error({ err }, "Failed to update plan");
    }
  }

  private async emit(
    client: LinearClient,
    content: { type: string; body?: string; action?: string; parameter?: string; result?: string },
    ephemeral?: boolean,
  ): Promise<void> {
    await this.rateLimiter.acquire();
    try {
      await client.createAgentActivity({
        agentSessionId: this.sessionId,
        content,
        ...(ephemeral ? { ephemeral: true } : {}),
      });
    } catch (err) {
      logger.error({ err, activityType: content.type }, "Failed to emit activity");
    }
  }
}

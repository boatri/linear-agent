import type { LinearClient } from "@linear/sdk";
import type {
  JournalEntry,
  AssistantEntry,
  UserEntry,
  SummaryEntry,
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types";
import { TOOL_MAPPING, truncate } from "./tool-mapping";
import { RateLimiter } from "./rate-limiter";

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
}

export class ActivityEmitter {
  private readonly sessionId: string;
  private readonly rateLimiter: RateLimiter;
  private readonly pendingToolUses = new Map<string, PendingTool>();

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
      // Skip: progress, file-history-snapshot, queue-operation, system
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
      } else if (block.type === "text" && !entry.toolUseResult) {
        // User prompt text (not a tool result wrapper)
        const text = block.text.trim();
        if (text) {
          await this.emit(client, { type: "prompt", body: truncate(text, 2000) });
        }
      }
    }
  }

  private async processSummary(entry: SummaryEntry, client: LinearClient): Promise<void> {
    await this.emit(client, {
      type: "thought",
      body: `Context: ${truncate(entry.summary, 2000)}`,
    });
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
    await this.emit(client, { type: "response", body: truncate(text, 2000) });
  }

  private async emitToolUse(block: ToolUseBlock, client: LinearClient): Promise<void> {
    // Store for pairing with tool_result
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

    // Extract result text
    const resultText =
      typeof block.content === "string"
        ? block.content
        : block.content.map((c) => c.text).join("\n");

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
      console.error(`[emitter] Failed to emit ${content.type}:`, err);
    }
  }
}

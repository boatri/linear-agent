import { describe, expect, test } from "bun:test";
import type { LinearSdk } from "@linear/sdk";
import type {
  AssistantEntry,
  UserEntry,
  SummaryEntry,
  QueueOperationEntry,
  ContentBlock,
  ToolResultBlock,
} from "../src/claude/types";
import { ActivityEmitter } from "../src/claude/emitter";

// --- Mock LinearSdk ---------------------------------------------------

function mockClient() {
  const activities: Array<Record<string, unknown>> = [];
  const planUpdates: Array<{ plan: unknown }> = [];
  return {
    client: {
      createAgentActivity: async (args: Record<string, unknown>) => {
        activities.push(args);
      },
      updateAgentSession: async (_id: string, args: { plan: unknown }) => {
        planUpdates.push(args);
      },
    } as unknown as LinearSdk,
    activities,
    planUpdates,
  };
}

// --- Entry builders -------------------------------------------------------

const BASE = {
  uuid: "uuid-1",
  timestamp: "2025-01-01T00:00:00Z",
  parentUuid: null,
  sessionId: "session-1",
} as const;

function assistant(block: ContentBlock): AssistantEntry {
  return {
    ...BASE,
    type: "assistant",
    message: { role: "assistant", content: [block], id: "msg-1", model: "claude" },
    requestId: "req-1",
  };
}

function userEntry(...results: ToolResultBlock[]): UserEntry {
  return {
    ...BASE,
    type: "user",
    message: { role: "user", content: results },
  };
}

// --- Tests ----------------------------------------------------------------

describe("ActivityEmitter", () => {
  const SESSION = "sess-test";

  describe("entry type dispatch", () => {
    test("skips unknown entry types without emitting", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);
      await emitter.process({ type: "progress", ...BASE, data: {} } as any, client);
      await emitter.process({ type: "file-history-snapshot" } as any, client);
      await emitter.process({ type: "system" } as any, client);
      expect(activities).toHaveLength(0);
    });

    test("skips assistant entry with empty content array", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);
      await emitter.process(
        { ...BASE, type: "assistant", message: { role: "assistant", content: [], id: "m", model: "c" }, requestId: "r" },
        client,
      );
      expect(activities).toHaveLength(0);
    });
  });

  describe("thinking blocks", () => {
    test("emits ephemeral thought", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({ type: "thinking", thinking: "Let me analyze..." }),
        client,
      );

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        agentSessionId: SESSION,
        content: { type: "thought", body: "Let me analyze..." },
        ephemeral: true,
      });
    });

    test("truncates long thinking to 2000 chars", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const long = "x".repeat(3000);
      await emitter.process(assistant({ type: "thinking", thinking: long }), client);

      expect((activities[0].content as any).body.length).toBe(2000);
    });
  });

  describe("text blocks", () => {
    test("emits response for non-empty text", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(assistant({ type: "text", text: "Here is the answer." }), client);

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        agentSessionId: SESSION,
        content: { type: "response", body: "Here is the answer." },
      });
    });

    test("skips empty or whitespace-only text", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(assistant({ type: "text", text: "" }), client);
      await emitter.process(assistant({ type: "text", text: "   \n  " }), client);

      expect(activities).toHaveLength(0);
    });
  });

  describe("tool_use → tool_result correlation", () => {
    test("tool_use stores pending and emits ephemeral action", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "Read",
          input: { file_path: "/src/main.ts" },
        }),
        client,
      );

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        agentSessionId: SESSION,
        content: { type: "action", action: "Read file", parameter: "/src/main.ts" },
        ephemeral: true,
      });
    });

    test("tool_result correlates with pending tool_use and emits final action", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      // Step 1: tool_use
      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { command: "ls" },
        }),
        client,
      );

      // Step 2: tool_result
      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "file.txt\ndir/",
        }),
        client,
      );

      // First: ephemeral action from tool_use
      expect(activities[0].ephemeral).toBe(true);

      // Second: final action from tool_result, includes result text
      expect(activities[1]).toEqual({
        agentSessionId: SESSION,
        content: {
          type: "action",
          action: "Ran command",
          parameter: "ls",
          result: "file.txt\ndir/",
        },
      });
    });

    test("tool_result with no matching pending is silently ignored", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "nonexistent",
          content: "whatever",
        }),
        client,
      );

      expect(activities).toHaveLength(0);
    });

    test("tool_use for unknown tool stores pending but emits nothing", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "SomeUnknownTool",
          input: { foo: "bar" },
        }),
        client,
      );

      // No mapper → no emission
      expect(activities).toHaveLength(0);

      // But result should still be silently dropped since mapper is missing
      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "result",
        }),
        client,
      );

      expect(activities).toHaveLength(0);
    });

    test("tool_result with array content joins text blocks", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "Read",
          input: { file_path: "/f.ts" },
        }),
        client,
      );

      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        }),
        client,
      );

      // The final action should have been emitted (Read doesn't use result, but the
      // join logic is still exercised for the plan tracker path)
      expect(activities).toHaveLength(2);
    });

    test("two concurrent tool_uses correlate with correct results", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      // Two tool_uses
      await emitter.process(
        assistant({ type: "tool_use", id: "tu-A", name: "Read", input: { file_path: "/a.ts" } }),
        client,
      );
      await emitter.process(
        assistant({ type: "tool_use", id: "tu-B", name: "Grep", input: { pattern: "TODO" } }),
        client,
      );

      // Results arrive in reverse order
      await emitter.process(
        userEntry({ type: "tool_result", tool_use_id: "tu-B", content: "match found" }),
        client,
      );
      await emitter.process(
        userEntry({ type: "tool_result", tool_use_id: "tu-A", content: "file contents" }),
        client,
      );

      // Ephemeral for A, ephemeral for B, result for B, result for A
      expect(activities).toHaveLength(4);

      // Result for tu-B (arrived first)
      expect((activities[2].content as any).action).toBe("Searched code");
      expect((activities[2].content as any).parameter).toBe("TODO");

      // Result for tu-A (arrived second)
      expect((activities[3].content as any).action).toBe("Read file");
      expect((activities[3].content as any).parameter).toBe("/a.ts");
    });
  });

  describe("error results", () => {
    test("is_error emits error activity with tool name and message", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "rm -rf /" } }),
        client,
      );

      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "Permission denied",
          is_error: true,
        }),
        client,
      );

      // Ephemeral action, then error
      expect(activities).toHaveLength(2);
      expect(activities[1]).toEqual({
        agentSessionId: SESSION,
        content: {
          type: "error",
          body: "**Bash** failed: Permission denied",
        },
      });
    });

    test("error result does not emit a regular action after the error", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({ type: "tool_use", id: "tu-1", name: "Edit", input: { file_path: "/x" } }),
        client,
      );
      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "file not found",
          is_error: true,
        }),
        client,
      );

      // Only ephemeral + error, no third "action" activity
      expect(activities).toHaveLength(2);
      expect((activities[1].content as any).type).toBe("error");
    });
  });

  describe("plan tracker integration", () => {
    test("TaskCreate result triggers plan update", async () => {
      const { client, planUpdates } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "TaskCreate",
          input: { subject: "Implement feature" },
        }),
        client,
      );

      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "Task #1 created successfully",
        }),
        client,
      );

      expect(planUpdates).toHaveLength(1);
      expect(planUpdates[0].plan).toEqual([
        { content: "Implement feature", status: "pending" },
      ]);
    });

    test("TaskUpdate result triggers plan update", async () => {
      const { client, planUpdates } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      // Create first
      await emitter.process(
        assistant({ type: "tool_use", id: "tu-1", name: "TaskCreate", input: { subject: "Step 1" } }),
        client,
      );
      await emitter.process(
        userEntry({ type: "tool_result", tool_use_id: "tu-1", content: "Task #1 ok" }),
        client,
      );

      // Then update
      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-2",
          name: "TaskUpdate",
          input: { taskId: "1", status: "completed" },
        }),
        client,
      );
      await emitter.process(
        userEntry({ type: "tool_result", tool_use_id: "tu-2", content: "Updated" }),
        client,
      );

      // Two plan updates: one after create, one after update
      expect(planUpdates).toHaveLength(2);
      expect(planUpdates[1].plan).toEqual([
        { content: "Step 1", status: "completed" },
      ]);
    });

    test("TodoWrite result replaces plan", async () => {
      const { client, planUpdates } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({
          type: "tool_use",
          id: "tu-1",
          name: "TodoWrite",
          input: { todos: [{ content: "A", status: "pending" }, { content: "B", status: "completed" }] },
        }),
        client,
      );
      await emitter.process(
        userEntry({ type: "tool_result", tool_use_id: "tu-1", content: "Todos written" }),
        client,
      );

      expect(planUpdates).toHaveLength(1);
      expect(planUpdates[0].plan).toEqual([
        { content: "A", status: "pending" },
        { content: "B", status: "completed" },
      ]);
    });

    test("error result on TaskCreate does not update plan", async () => {
      const { client, planUpdates, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      await emitter.process(
        assistant({ type: "tool_use", id: "tu-1", name: "TaskCreate", input: { subject: "X" } }),
        client,
      );
      await emitter.process(
        userEntry({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "Task creation failed",
          is_error: true,
        }),
        client,
      );

      // Plan should NOT be updated (error path skips plan tracker)
      // Wait — actually looking at the source, the plan tracker IS called before the error check.
      // The code does: if (!block.is_error) { switch... planTracker... }
      // So error results skip the plan tracker. Good.
      expect(planUpdates).toHaveLength(0);
    });
  });

  describe("summary entries", () => {
    test("emits thought with truncated summary", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: SummaryEntry = {
        type: "summary",
        summary: "User asked about authentication and we discussed JWT tokens.",
        leafUuid: "leaf-1",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        agentSessionId: SESSION,
        content: {
          type: "thought",
          body: "Context: User asked about authentication and we discussed JWT tokens.",
        },
      });
    });
  });

  describe("queue-operation entries", () => {
    test("enqueue with <summary> emits action", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: QueueOperationEntry = {
        type: "queue-operation",
        operation: "enqueue",
        content: "<summary>Automated test run completed</summary>",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual({
        agentSessionId: SESSION,
        content: { type: "action", body: "Automated test run completed" },
      });
    });

    test("enqueue with <status>failed</status> emits error", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: QueueOperationEntry = {
        type: "queue-operation",
        operation: "enqueue",
        content: "<summary>Build failed</summary><status>failed</status>",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(1);
      expect((activities[0].content as any).type).toBe("error");
      expect((activities[0].content as any).body).toBe("Build failed");
    });

    test("enqueue without <summary> tag emits nothing", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: QueueOperationEntry = {
        type: "queue-operation",
        operation: "enqueue",
        content: "just a plain user message",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(0);
    });

    test("non-enqueue operation emits nothing", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: QueueOperationEntry = {
        type: "queue-operation",
        operation: "dequeue",
        content: "<summary>Something</summary>",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(0);
    });

    test("enqueue with no content emits nothing", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: QueueOperationEntry = {
        type: "queue-operation",
        operation: "enqueue",
      };
      await emitter.process(entry, client);

      expect(activities).toHaveLength(0);
    });
  });

  describe("user entry processing", () => {
    test("user text blocks are skipped, only tool_results processed", async () => {
      const { client, activities } = mockClient();
      const emitter = new ActivityEmitter(SESSION);

      const entry: UserEntry = {
        ...BASE,
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Please fix the bug" },
            { type: "tool_result", tool_use_id: "nonexistent", content: "result" },
          ],
        },
      };
      await emitter.process(entry, client);

      // Text skipped, tool_result has no pending match → nothing emitted
      expect(activities).toHaveLength(0);
    });
  });
});

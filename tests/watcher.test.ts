import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LinearSdk } from "@linear/sdk";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Watcher } from "../src/claude/watcher";

// --- Mock LinearSdk (captures calls) -----------------------------------

function mockClient() {
  const activities: Array<Record<string, unknown>> = [];
  return {
    client: {
      createAgentActivity: async (args: Record<string, unknown>) => {
        activities.push(args);
      },
      updateAgentSession: async () => {},
    } as unknown as LinearSdk,
    activities,
  };
}

// --- Helpers ---------------------------------------------------------------

// Build a TailedFile matching the watcher's private interface
function tailedFile(path: string, byteOffset = 0) {
  return {
    path,
    byteOffset,
    lineBuffer: "",
    lineCount: 0,
    lastUuid: "",
    linesSinceSave: 0,
  };
}

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

const SESSION_ID = "test-session-id";
const ENTRY_BASE = {
  uuid: "uuid-1",
  timestamp: "2025-01-01T00:00:00Z",
  parentUuid: null,
  sessionId: SESSION_ID,
};

// --- Tests -----------------------------------------------------------------

describe("Watcher internals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Access private methods via bracket notation
  function createWatcher() {
    const mock = mockClient();
    const watcher = new Watcher({ sessionId: SESSION_ID }, mock.client);
    return { watcher, ...mock };
  }

  describe("readNewLines", () => {
    test("processes complete JSONL lines and increments lineCount", async () => {
      const { watcher, activities } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");

      writeFileSync(
        filePath,
        jsonl(
          { ...ENTRY_BASE, type: "summary", summary: "first", leafUuid: "l1" },
          { ...ENTRY_BASE, type: "summary", summary: "second", leafUuid: "l2" },
        ),
      );

      const file = tailedFile(filePath);
      const bytesRead = await (watcher as any).readNewLines(file);

      expect(bytesRead).toBeGreaterThan(0);
      expect(file.lineCount).toBe(2);
      expect(file.lineBuffer).toBe("");
      // Both summaries should have been emitted as thoughts
      expect(activities).toHaveLength(2);
    });

    test("buffers partial line that doesn't end with newline", async () => {
      const { watcher, activities } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");

      const complete = JSON.stringify({
        ...ENTRY_BASE,
        type: "summary",
        summary: "complete",
        leafUuid: "l1",
      });
      const partial = '{"type":"summary","summary":"incom';

      // Write one complete line and one partial (no trailing newline)
      writeFileSync(filePath, complete + "\n" + partial);

      const file = tailedFile(filePath);
      await (watcher as any).readNewLines(file);

      // Only the complete line should be processed
      expect(file.lineCount).toBe(1);
      expect(file.lineBuffer).toBe(partial);
      expect(activities).toHaveLength(1);

      // byteOffset stays at end of file (partial is tracked in lineBuffer, not by offset)
      expect(file.byteOffset).toBe(Buffer.byteLength(complete + "\n" + partial));
    });

    test("joins buffered partial with next chunk", async () => {
      const { watcher, activities } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");

      const entry = {
        ...ENTRY_BASE,
        type: "summary",
        summary: "rejoined",
        leafUuid: "l1",
      };
      const full = JSON.stringify(entry);
      const splitAt = 20;

      // Write first part (no newline)
      writeFileSync(filePath, full.slice(0, splitAt));

      const file = tailedFile(filePath);
      await (watcher as any).readNewLines(file);

      expect(file.lineCount).toBe(0);
      expect(file.lineBuffer).toBe(full.slice(0, splitAt));

      // Append the rest with newline
      appendFileSync(filePath, full.slice(splitAt) + "\n");
      await (watcher as any).readNewLines(file);

      expect(file.lineCount).toBe(1);
      expect(file.lineBuffer).toBe("");
      expect(activities).toHaveLength(1);
    });

    test("returns 0 when file has no new bytes", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");
      writeFileSync(filePath, "");

      const file = tailedFile(filePath);
      const bytesRead = await (watcher as any).readNewLines(file);
      expect(bytesRead).toBe(0);
    });

    test("skips empty lines", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");

      writeFileSync(filePath, "\n\n\n");

      const file = tailedFile(filePath);
      await (watcher as any).readNewLines(file);
      expect(file.lineCount).toBe(0);
    });
  });

  describe("processLine", () => {
    test("skips malformed JSON without crashing", async () => {
      const { watcher } = createWatcher();
      const file = tailedFile(join(tmpDir, "x.jsonl"));

      // Should not throw
      await (watcher as any).processLine(file, "this is not json {{{");
      expect(file.lineCount).toBe(0);
    });

    test("extracts uuid from entry", async () => {
      const { watcher } = createWatcher();
      const file = tailedFile(join(tmpDir, "x.jsonl"));

      await (watcher as any).processLine(
        file,
        JSON.stringify({ ...ENTRY_BASE, uuid: "abc-123", type: "progress", data: {} }),
      );

      expect(file.lastUuid).toBe("abc-123");
      expect(file.lineCount).toBe(1);
    });

    test("collects sessionId into knownSessionIds", async () => {
      const { watcher } = createWatcher();
      const file = tailedFile(join(tmpDir, "x.jsonl"));

      await (watcher as any).processLine(
        file,
        JSON.stringify({ ...ENTRY_BASE, sessionId: "new-session-xyz", type: "progress", data: {} }),
      );

      const known: Set<string> = (watcher as any).knownSessionIds;
      expect(known.has("new-session-xyz")).toBe(true);
    });
  });

  describe("isLinkedSession", () => {
    test("returns true when file contains matching sessionId in first lines", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "linked.jsonl");

      writeFileSync(
        filePath,
        jsonl(
          { sessionId: SESSION_ID, type: "progress", uuid: "u1", timestamp: "", parentUuid: null, data: {} },
        ),
      );

      const result = await (watcher as any).isLinkedSession(filePath);
      expect(result).toBe(true);
    });

    test("returns false when file has no matching sessionId", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "unrelated.jsonl");

      writeFileSync(
        filePath,
        jsonl(
          { sessionId: "different-session", type: "progress", uuid: "u1", timestamp: "", parentUuid: null, data: {} },
        ),
      );

      const result = await (watcher as any).isLinkedSession(filePath);
      expect(result).toBe(false);
    });

    test("returns false for non-existent file", async () => {
      const { watcher } = createWatcher();
      const result = await (watcher as any).isLinkedSession(join(tmpDir, "nope.jsonl"));
      expect(result).toBe(false);
    });

    test("returns false when first lines are malformed JSON", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "bad.jsonl");
      writeFileSync(filePath, "not json\nalso not json\n");

      const result = await (watcher as any).isLinkedSession(filePath);
      expect(result).toBe(false);
    });

    test("only checks first N lines (MAX_LINK_CHECK_LINES = 5)", async () => {
      const { watcher } = createWatcher();
      const filePath = join(tmpDir, "deep.jsonl");

      // 6 lines of unrelated entries, then the matching one on line 7
      const lines = [];
      for (let i = 0; i < 6; i++) {
        lines.push(JSON.stringify({ sessionId: "other", type: "progress" }));
      }
      lines.push(JSON.stringify({ sessionId: SESSION_ID, type: "progress" }));
      writeFileSync(filePath, lines.join("\n") + "\n");

      const result = await (watcher as any).isLinkedSession(filePath);
      expect(result).toBe(false);
    });
  });

  describe("end-to-end JSONL → emitter pipeline", () => {
    test("tool_use followed by tool_result emits correlated activities", async () => {
      const { watcher, activities } = createWatcher();
      const filePath = join(tmpDir, "session.jsonl");

      writeFileSync(
        filePath,
        jsonl(
          {
            ...ENTRY_BASE,
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/f.ts" } },
              ],
              id: "msg-1",
              model: "claude",
            },
            requestId: "req-1",
          },
          {
            ...ENTRY_BASE,
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "file contents" },
              ],
            },
          },
        ),
      );

      const file = tailedFile(filePath);
      await (watcher as any).readNewLines(file);

      expect(file.lineCount).toBe(2);
      // Ephemeral action from tool_use + final action from tool_result
      expect(activities).toHaveLength(2);
      expect((activities[0].content as any).action).toBe("Read file");
      expect(activities[0].ephemeral).toBe(true);
      expect((activities[1].content as any).action).toBe("Read file");
      expect(activities[1]).not.toHaveProperty("ephemeral");
    });
  });
});

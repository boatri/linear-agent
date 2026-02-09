import { describe, expect, test } from "bun:test";
import { truncate, TOOL_MAPPING } from "../src/claude/tool-mapping";

describe("truncate", () => {
  test("returns empty string unchanged", () => {
    expect(truncate("", 10)).toBe("");
  });

  test("returns string at exact limit unchanged", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("truncates over limit with ellipsis to exactly max chars", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello...");
    expect(result.length).toBe(8);
  });

  test("max < 3 produces ellipsis that exceeds stated max", () => {
    // This is a real edge case: slice(0, -1) + "..." = "hell..." which is 7 chars
    // but with max=2: slice(0, -1) + "..." = "hell..." — no, let's be precise:
    // truncate("hello", 2) => "hello".slice(0, 2-3) + "..." = "hello".slice(0,-1) + "..." = "hell..."
    // That's 7 chars, way over max=2. The function doesn't guard against this.
    const result = truncate("hello", 2);
    expect(result.length).toBeGreaterThan(2);
  });
});

describe("TOOL_MAPPING", () => {
  test("Bash truncates long commands to 200 chars", () => {
    const long = "x".repeat(300);
    const out = TOOL_MAPPING.Bash({ command: long });
    expect(out.parameter.length).toBe(200);
    expect(out.parameter.endsWith("...")).toBe(true);
  });

  test("Bash conditionally spreads result only when provided", () => {
    const withResult = TOOL_MAPPING.Bash({ command: "ls" }, "output");
    expect(withResult.result).toBe("output");

    const without = TOOL_MAPPING.Bash({ command: "ls" });
    expect(without).not.toHaveProperty("result");
  });

  test("AskUserQuestion drills into questions array for first question", () => {
    const out = TOOL_MAPPING.AskUserQuestion({
      questions: [{ question: "Which approach?" }, { question: "Second?" }],
    });
    expect(out.parameter).toBe("Which approach?");

    const empty = TOOL_MAPPING.AskUserQuestion({});
    expect(empty.parameter).toBe("");
  });

  test("missing input fields default to empty string via nullish coalescing", () => {
    expect(TOOL_MAPPING.Bash({}).parameter).toBe("");
    expect(TOOL_MAPPING.Edit({}).parameter).toBe("");
    expect(TOOL_MAPPING.Grep({}).parameter).toBe("");
    expect(TOOL_MAPPING.Task({}).parameter).toBe("");
  });
});

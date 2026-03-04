import { describe, expect, test } from "bun:test";
import { TOOL_MAPPING } from "../src/claude/tool-mapping";

describe("TOOL_MAPPING", () => {
  test("Bash passes full command and result", () => {
    const long = "x".repeat(300);
    const out = TOOL_MAPPING.Bash({ command: long });
    expect(out.parameter).toBe(long);
  });

  test("Bash conditionally spreads result only when provided", () => {
    const withResult = TOOL_MAPPING.Bash({ command: "ls" }, "output");
    expect(withResult.result).toBe("output");

    const without = TOOL_MAPPING.Bash({ command: "ls" });
    expect(without).not.toHaveProperty("result");
  });

  test("missing input fields default to empty string via nullish coalescing", () => {
    expect(TOOL_MAPPING.Bash({}).parameter).toBe("");
    expect(TOOL_MAPPING.Edit({}).parameter).toBe("");
    expect(TOOL_MAPPING.Grep({}).parameter).toBe("");
    expect(TOOL_MAPPING.Agent({}).parameter).toBe("");
  });
});

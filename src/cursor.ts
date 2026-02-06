import { readFileSync, writeFileSync } from "fs";
import type { CursorState } from "./types";

function cursorPath(sessionId: string): string {
  return `/tmp/claude-linear-cursor-${sessionId}.json`;
}

export function loadCursor(sessionId: string): CursorState | null {
  try {
    const data = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8")) as CursorState;
    if (typeof data.byteOffset === "number" && typeof data.lineCount === "number") {
      return data;
    }
  } catch {
    // No cursor or invalid — start from beginning
  }
  return null;
}

export function saveCursor(sessionId: string, cursor: CursorState): void {
  try {
    writeFileSync(cursorPath(sessionId), JSON.stringify(cursor));
  } catch {
    // Non-fatal
  }
}

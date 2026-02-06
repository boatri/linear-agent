import type { LinearClient } from "@linear/sdk";
import type { JournalEntry, WatcherConfig } from "./types";
import { findSessionFile } from "./session-finder";
import { loadCursor, saveCursor } from "./cursor";
import { ActivityEmitter } from "./emitter";

const FILE_POLL_MS = 500;
const CURSOR_SAVE_LINES = 10;
const CURSOR_SAVE_MS = 5_000;

export class Watcher {
  private readonly config: WatcherConfig;
  private readonly client: LinearClient;
  private readonly emitter: ActivityEmitter;
  private stopping = false;
  private byteOffset = 0;
  private lineCount = 0;
  private lastUuid = "";
  private linesSinceSave = 0;
  private lastSaveTime = Date.now();
  private lineBuffer = "";

  constructor(config: WatcherConfig, client: LinearClient) {
    this.config = config;
    this.client = client;
    this.emitter = new ActivityEmitter(config.sessionId);
  }

  async run(): Promise<void> {
    // Restore cursor if resuming
    const cursor = loadCursor(this.config.sessionId);
    if (cursor) {
      this.byteOffset = cursor.byteOffset;
      this.lineCount = cursor.lineCount;
      this.lastUuid = cursor.lastUuid;
      console.error(`[watcher] Resuming from line ${this.lineCount}, byte ${this.byteOffset}`);
    }

    // Set up signal handlers
    const shutdown = () => {
      if (this.stopping) return;
      this.stopping = true;
      console.error("[watcher] Shutting down...");
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // Poll for file existence
    let filePath: string | null = null;
    while (!this.stopping) {
      filePath = await findSessionFile(this.config.sessionId);
      if (filePath) break;
      console.error(`[watcher] Waiting for session file...`);
      await sleep(FILE_POLL_MS);
    }

    if (!filePath || this.stopping) {
      this.persistCursor();
      return;
    }

    console.error(`[watcher] Found session file: ${filePath}`);

    // Main tailing loop
    while (!this.stopping) {
      const bytesRead = await this.readNewLines(filePath);
      if (bytesRead === 0) {
        await sleep(FILE_POLL_MS);
      }
      this.maybeSaveCursor();
    }

    // Final flush: read any remaining lines
    await this.readNewLines(filePath);
    this.persistCursor();
    console.error(`[watcher] Stopped. Processed ${this.lineCount} lines.`);
  }

  private async readNewLines(filePath: string): Promise<number> {
    const file = Bun.file(filePath);
    const size = file.size;

    if (size <= this.byteOffset) return 0;

    const chunk = await file.slice(this.byteOffset, size).text();
    const startOffset = this.byteOffset;
    this.byteOffset = size;

    // Prepend any buffered incomplete line
    const data = this.lineBuffer + chunk;
    this.lineBuffer = "";

    const lines = data.split("\n");

    // If data doesn't end with \n, the last element is incomplete
    if (!data.endsWith("\n")) {
      this.lineBuffer = lines.pop()!;
      // Adjust byte offset: we haven't consumed the incomplete line
      this.byteOffset -= Buffer.byteLength(this.lineBuffer);
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.processLine(trimmed);
    }

    return size - startOffset;
  }

  private async processLine(line: string): Promise<void> {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      return; // Skip malformed lines
    }

    this.lineCount++;
    if ("uuid" in entry && typeof entry.uuid === "string") {
      this.lastUuid = entry.uuid;
    }
    this.linesSinceSave++;

    await this.emitter.process(entry, this.client);
  }

  private maybeSaveCursor(): void {
    const now = Date.now();
    if (
      this.linesSinceSave >= CURSOR_SAVE_LINES ||
      now - this.lastSaveTime >= CURSOR_SAVE_MS
    ) {
      this.persistCursor();
    }
  }

  private persistCursor(): void {
    saveCursor(this.config.sessionId, {
      byteOffset: this.byteOffset,
      lineCount: this.lineCount,
      lastUuid: this.lastUuid,
    });
    this.linesSinceSave = 0;
    this.lastSaveTime = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

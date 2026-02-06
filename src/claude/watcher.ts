import type { LinearClient } from "@linear/sdk";
import type { JournalEntry, WatcherConfig } from "./types";
import { findSessionFile, listProjectSessions } from "./session-finder";
import { loadCursor, saveCursor } from "./cursor";
import { ActivityEmitter } from "./emitter";
import { logger as rootLogger } from "../logger";

const logger = rootLogger.child({ module: "watcher" });

const FILE_POLL_MS = 500;
const SUCCESSOR_SCAN_MS = 3_000;
const CURSOR_SAVE_LINES = 10;
const CURSOR_SAVE_MS = 5_000;
const MAX_LINK_CHECK_LINES = 5;

interface TailedFile {
  path: string;
  byteOffset: number;
  lineBuffer: string;
  lineCount: number;
  lastUuid: string;
  linesSinceSave: number;
}

export class Watcher {
  private readonly config: WatcherConfig;
  private readonly client: LinearClient;
  private readonly emitter: ActivityEmitter;
  private stopping = false;
  private lastSaveTime = Date.now();
  private lastScanTime = 0;

  private readonly files = new Map<string, TailedFile>();

  private readonly knownSessionIds = new Set<string>();

  private readonly checkedFiles = new Set<string>();

  constructor(config: WatcherConfig, client: LinearClient) {
    this.config = config;
    this.client = client;
    this.emitter = new ActivityEmitter(config.sessionId);
    this.knownSessionIds.add(config.sessionId);
  }

  async run(): Promise<void> {
    const shutdown = () => {
      if (this.stopping) return;
      this.stopping = true;
      logger.info("Shutting down...");
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    let filePath: string | null = null;
    let loggedWaiting = false;
    while (!this.stopping) {
      filePath = await findSessionFile(this.config.sessionId);
      if (filePath) break;
      if (!loggedWaiting) {
        logger.info("Waiting for session file...");
        loggedWaiting = true;
      }
      await sleep(FILE_POLL_MS);
    }

    if (!filePath || this.stopping) {
      this.persistAllCursors();
      return;
    }

    logger.info({ path: filePath }, "Found session file");
    this.addFile(filePath);

    while (!this.stopping) {
      let totalBytesRead = 0;
      for (const file of this.files.values()) {
        totalBytesRead += await this.readNewLines(file);
      }
      await this.scanForSuccessors();
      if (totalBytesRead === 0) {
        await sleep(FILE_POLL_MS);
      }
      this.maybeSaveCursors();
    }

    for (const file of this.files.values()) {
      await this.readNewLines(file);
    }
    this.persistAllCursors();
    const totalLines = [...this.files.values()].reduce((sum, f) => sum + f.lineCount, 0);
    logger.info({ lines: totalLines, files: this.files.size }, "Stopped");
  }

  private addFile(filePath: string): void {
    if (this.files.has(filePath)) return;

    const cursor = loadCursor(filePath);
    const file: TailedFile = {
      path: filePath,
      byteOffset: cursor?.byteOffset ?? 0,
      lineBuffer: "",
      lineCount: cursor?.lineCount ?? 0,
      lastUuid: cursor?.lastUuid ?? "",
      linesSinceSave: 0,
    };

    if (cursor) {
      logger.info({ path: filePath, line: cursor.lineCount, byte: cursor.byteOffset }, "Resuming file from cursor");
    }

    this.files.set(filePath, file);
    this.checkedFiles.add(filePath);
  }

  private async scanForSuccessors(): Promise<void> {
    const now = Date.now();
    if (now - this.lastScanTime < SUCCESSOR_SCAN_MS) return;
    this.lastScanTime = now;

    const anyFile = this.files.values().next().value;
    if (!anyFile) return;

    const candidates = await listProjectSessions(anyFile.path);
    for (const candidate of candidates) {
      if (this.checkedFiles.has(candidate)) continue;
      this.checkedFiles.add(candidate);

      if (await this.isLinkedSession(candidate)) {
        logger.info({ path: candidate }, "Found linked successor session");
        this.addFile(candidate);
      }
    }
  }

  private async isLinkedSession(filePath: string): Promise<boolean> {
    try {
      const file = Bun.file(filePath);
      const head = await file.slice(0, Math.min(file.size, 32_768)).text();
      const lines = head.split("\n").slice(0, MAX_LINK_CHECK_LINES);

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId && this.knownSessionIds.has(entry.sessionId)) {
            return true;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File might be gone or unreadable
    }
    return false;
  }

  private async readNewLines(file: TailedFile): Promise<number> {
    const bunFile = Bun.file(file.path);
    const size = bunFile.size;

    if (size <= file.byteOffset) return 0;

    const chunk = await bunFile.slice(file.byteOffset, size).text();
    const startOffset = file.byteOffset;
    file.byteOffset = size;

    const data = file.lineBuffer + chunk;
    file.lineBuffer = "";

    const lines = data.split("\n");

    if (!data.endsWith("\n")) {
      file.lineBuffer = lines.pop()!;
      file.byteOffset -= Buffer.byteLength(file.lineBuffer);
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.processLine(file, trimmed);
    }

    return size - startOffset;
  }

  private async processLine(file: TailedFile, line: string): Promise<void> {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      return;
    }

    file.lineCount++;
    if ("uuid" in entry && typeof entry.uuid === "string") {
      file.lastUuid = entry.uuid;
    }
    if ("sessionId" in entry && typeof entry.sessionId === "string") {
      this.knownSessionIds.add(entry.sessionId);
    }
    file.linesSinceSave++;

    try {
      await this.emitter.process(entry, this.client);
    } catch (err) {
      logger.error({ err, file: file.path, line: file.lineCount }, "Error processing line");
    }
  }

  private maybeSaveCursors(): void {
    const now = Date.now();
    const needsSave = now - this.lastSaveTime >= CURSOR_SAVE_MS ||
      [...this.files.values()].some((f) => f.linesSinceSave >= CURSOR_SAVE_LINES);
    if (needsSave) {
      this.persistAllCursors();
    }
  }

  private persistAllCursors(): void {
    for (const file of this.files.values()) {
      if (file.linesSinceSave > 0 || file.lineCount > 0) {
        saveCursor(file.path, {
          byteOffset: file.byteOffset,
          lineCount: file.lineCount,
          lastUuid: file.lastUuid,
        });
        file.linesSinceSave = 0;
      }
    }
    this.lastSaveTime = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

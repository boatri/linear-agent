import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { CursorState } from './types'

// Persist cursors outside /tmp so they survive instance reboots
const CURSOR_DIR = join(homedir(), '.local', 'share', 'linear-agent', 'cursors')

function cursorPath(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return join(CURSOR_DIR, `${hash}.json`)
}

export function loadCursor(filePath: string): CursorState | null {
  try {
    const data = JSON.parse(readFileSync(cursorPath(filePath), 'utf-8')) as CursorState
    if (typeof data.byteOffset === 'number' && typeof data.lineCount === 'number') {
      return data
    }
  } catch {
    // No cursor or invalid — start from beginning
  }
  return null
}

export function saveCursor(filePath: string, cursor: CursorState): void {
  try {
    mkdirSync(CURSOR_DIR, { recursive: true })
    writeFileSync(cursorPath(filePath), JSON.stringify(cursor))
  } catch {
    // Non-fatal
  }
}

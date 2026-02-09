import { readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import type { CursorState } from './types'

function cursorPath(filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return `/tmp/claude-linear-cursor-${hash}.json`
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
    writeFileSync(cursorPath(filePath), JSON.stringify(cursor))
  } catch {
    // Non-fatal
  }
}

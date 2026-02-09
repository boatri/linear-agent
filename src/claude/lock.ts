import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOCK_DIR = join(tmpdir(), 'linear-agent-locks')

interface LockInfo {
  pid: number
  sessionId: string
  createdAt: number
}

function lockPath(sessionId: string): string {
  return join(LOCK_DIR, `${sessionId}.lock`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireLock(sessionId: string): boolean {
  mkdirSync(LOCK_DIR, { recursive: true })

  const path = lockPath(sessionId)

  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf8')
      const lock: LockInfo = JSON.parse(content)

      if (isProcessAlive(lock.pid)) {
        return false
      }

      rmSync(path, { force: true })
    } catch {
      rmSync(path, { force: true })
    }
  }

  const lock: LockInfo = {
    pid: process.pid,
    sessionId,
    createdAt: Date.now(),
  }

  try {
    writeFileSync(path, JSON.stringify(lock), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

export function releaseLock(sessionId: string): void {
  const path = lockPath(sessionId)
  try {
    const content = readFileSync(path, 'utf8')
    const lock: LockInfo = JSON.parse(content)

    if (lock.pid === process.pid) {
      rmSync(path, { force: true })
    }
  } catch {
    // Lock already gone or invalid
  }
}

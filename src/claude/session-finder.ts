import { homedir } from 'os'
import { dirname } from 'path'
import { Glob } from 'bun'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

export async function findSessionFile(sessionId: string): Promise<string | null> {
  const claudeDir = `${homedir()}/.claude/projects`
  try {
    const glob = new Glob(`*/${sessionId}.jsonl`)
    for await (const match of glob.scan({ cwd: claudeDir, absolute: true })) {
      return match
    }
  } catch {
    // Directory may not exist yet if Claude hasn't started
  }
  return null
}

export async function listProjectSessions(sessionFilePath: string): Promise<string[]> {
  const projectDir = dirname(sessionFilePath)
  const glob = new Glob('*.jsonl')
  const results: string[] = []
  for await (const match of glob.scan({ cwd: projectDir, absolute: true })) {
    const basename = match.split('/').pop()!
    if (UUID_RE.test(basename)) {
      results.push(match)
    }
  }
  return results
}

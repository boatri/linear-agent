import { homedir } from "os";
import { Glob } from "bun";

export async function findSessionFile(sessionId: string): Promise<string | null> {
  const claudeDir = `${homedir()}/.claude/projects`;
  const glob = new Glob(`*/${sessionId}.jsonl`);
  for await (const match of glob.scan({ cwd: claudeDir, absolute: true })) {
    return match;
  }
  return null;
}

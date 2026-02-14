export async function resolveGitHubLogin(userId: string): Promise<string | null> {
  const resp = await fetch(`https://api.github.com/user/${userId}`)
  if (!resp.ok) return null
  const gh = (await resp.json()) as { login: string }
  return gh.login
}

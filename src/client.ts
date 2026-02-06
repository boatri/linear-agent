import { LinearClient } from "@linear/sdk";
import { getAccessToken, clearCachedToken } from "./auth";

export async function createClient(): Promise<LinearClient> {
  const accessToken = await getAccessToken();
  return new LinearClient({ accessToken });
}

/**
 * Run a function with the Linear client, retrying once with a fresh token on 401.
 */
export async function withClient<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
  const client = await createClient();
  try {
    return await fn(client);
  } catch (err: unknown) {
    if (isAuthError(err)) {
      clearCachedToken();
      const freshClient = await createClient();
      return await fn(freshClient);
    }
    throw err;
  }
}

function isAuthError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  // Linear SDK includes response status in the error
  if (e.status === 401) return true;
  const response = e.response as Record<string, unknown> | undefined;
  if (response?.status === 401) return true;
  return false;
}

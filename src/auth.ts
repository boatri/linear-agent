import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "path";

interface CachedToken {
  access_token: string;
  expires_at: number;
}

function getCachePath(): string {
  const clientId = process.env.LINEAR_CLIENT_ID ?? "";
  const hash = createHash("sha256").update(clientId).digest("hex").slice(0, 12);
  return `/tmp/claude-linear-token-${hash}.json`;
}

function readCachedToken(): string | null {
  try {
    const data = JSON.parse(readFileSync(getCachePath(), "utf-8")) as CachedToken;
    // Valid if not expired, with 1 hour buffer
    if (data.access_token && data.expires_at > Date.now() + 3600_000) {
      return data.access_token;
    }
  } catch {
    // No cache or invalid — fetch fresh
  }
  return null;
}

function writeCachedToken(accessToken: string, expiresIn: number): void {
  const cachePath = getCachePath();
  const data: CachedToken = {
    access_token: accessToken,
    expires_at: Date.now() + expiresIn * 1000,
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data), { mode: 0o600 });
  } catch {
    // Cache write failure is non-fatal
  }
}

async function fetchToken(): Promise<string> {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token fetch failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  writeCachedToken(result.access_token, result.expires_in);
  return result.access_token;
}

export function clearCachedToken(): void {
  try {
    unlinkSync(getCachePath());
  } catch {
    // Already gone
  }
}

export async function getAccessToken(): Promise<string> {
  const cached = readCachedToken();
  if (cached) return cached;
  return fetchToken();
}

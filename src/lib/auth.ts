import fs from "node:fs/promises";
import path from "node:path";

import type { AuthSession, SessionStore, SessionSummary } from "../types.js";
import { isParseFailure, tryParseJson, writeJson } from "./json.js";

export function buildSessionKey({ version, baseUrl, username }: { version?: string | null; baseUrl?: string | null; username?: string | null }): string {
  return JSON.stringify({
    version: version ?? "",
    baseUrl: baseUrl ?? "",
    username: username ?? "",
  });
}

export function maskToken(token: string | null | undefined): string | null {
  if (!token) {
    return null;
  }

  if (token.length <= 8) {
    return "***";
  }

  if (token.length <= 16) {
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64").toString("utf8");
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  const parsed = tryParseJson(decodeBase64Url(parts[1]));
  if (isParseFailure(parsed) || typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function getTokenExpiresAt(token: string | null | undefined): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return null;
  }

  return new Date(payload.exp * 1000).toISOString();
}

export function isExpired(expiresAt: string | null | undefined, skewSeconds = 30): boolean {
  if (!expiresAt) {
    return false;
  }

  return Date.now() >= new Date(expiresAt).getTime() - skewSeconds * 1000;
}

async function readSessionStore(sessionPath: string): Promise<SessionStore> {
  try {
    return JSON.parse(await fs.readFile(sessionPath, "utf8")) as SessionStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { sessions: {} };
    }

    throw error;
  }
}

async function writeSessionStore(sessionPath: string, store: SessionStore): Promise<void> {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await writeJson(sessionPath, store);
}

export async function readSession(sessionPath: string, key: string): Promise<AuthSession | null> {
  const store = await readSessionStore(sessionPath);
  return store.sessions?.[key] ?? null;
}

export async function writeSession(sessionPath: string, key: string, session: AuthSession): Promise<AuthSession> {
  const store = await readSessionStore(sessionPath);
  store.sessions ??= {};
  store.sessions[key] = session;
  await writeSessionStore(sessionPath, store);
  return session;
}

export async function deleteSession(sessionPath: string, key: string): Promise<void> {
  const store = await readSessionStore(sessionPath);
  if (store.sessions?.[key]) {
    delete store.sessions[key];
    await writeSessionStore(sessionPath, store);
  }
}

export function summarizeSession(session: AuthSession | null): SessionSummary {
  if (!session) {
    return {
      cached: false,
    };
  }

  return {
    cached: true,
    username: session.username ?? null,
    baseUrl: session.baseUrl ?? null,
    version: session.version ?? null,
    tokenType: session.tokenType ?? null,
    hasAccessToken: Boolean(session.accessToken),
    hasRefreshToken: Boolean(session.refreshToken),
    accessToken: maskToken(session.accessToken),
    refreshToken: maskToken(session.refreshToken),
    accessTokenExpiresAt: session.accessTokenExpiresAt ?? null,
    updatedAt: session.updatedAt ?? null,
  };
}

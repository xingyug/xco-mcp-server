import fs from "node:fs/promises";
import path from "node:path";

import { tryParseJson, writeJson } from "./json.js";

export function buildSessionKey({ version, baseUrl, username }) {
  return JSON.stringify({
    version: version ?? "",
    baseUrl: baseUrl ?? "",
    username: username ?? "",
  });
}

export function maskToken(token) {
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

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  return tryParseJson(decodeBase64Url(parts[1]));
}

export function getTokenExpiresAt(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return null;
  }

  return new Date(payload.exp * 1000).toISOString();
}

export function isExpired(expiresAt, skewSeconds = 30) {
  if (!expiresAt) {
    return false;
  }

  return Date.now() >= new Date(expiresAt).getTime() - skewSeconds * 1000;
}

async function readSessionStore(sessionPath) {
  try {
    return JSON.parse(await fs.readFile(sessionPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return { sessions: {} };
    }

    throw error;
  }
}

async function writeSessionStore(sessionPath, store) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await writeJson(sessionPath, store);
}

export async function readSession(sessionPath, key) {
  const store = await readSessionStore(sessionPath);
  return store.sessions?.[key] ?? null;
}

export async function writeSession(sessionPath, key, session) {
  const store = await readSessionStore(sessionPath);
  store.sessions ??= {};
  store.sessions[key] = session;
  await writeSessionStore(sessionPath, store);
  return session;
}

export async function deleteSession(sessionPath, key) {
  const store = await readSessionStore(sessionPath);
  if (store.sessions?.[key]) {
    delete store.sessions[key];
    await writeSessionStore(sessionPath, store);
  }
}

export function summarizeSession(session) {
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

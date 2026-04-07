import fs from "node:fs/promises";
import path from "node:path";

import type { ConfigOverrides, LoadConfigOptions, XcoConfig } from "../types.js";
import { readJson, writeJson } from "./json.js";
import { mergeDefined, toAbsolutePath } from "./utils.js";

function parseBooleanish(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseBooleanishNullable(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<XcoConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const xcoHome = toAbsolutePath(cwd, env.XCO_HOME ?? ".xco") ?? ".xco";
  const configPath = toAbsolutePath(
    cwd,
    env.XCO_CONFIG ?? path.join(xcoHome, "config.json"),
  ) ?? path.join(xcoHome, "config.json");
  const sessionPath = toAbsolutePath(
    cwd,
    env.XCO_SESSION_PATH ?? path.join(xcoHome, "session.json"),
  ) ?? path.join(xcoHome, "session.json");
  const manualSpecsDir = toAbsolutePath(cwd, env.XCO_SPECS_DIR ?? "specs") ?? "specs";

  let fileConfig: Record<string, unknown> = {};
  try {
    fileConfig = (await readJson(configPath)) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const merged = mergeDefined(fileConfig, {
    activeVersion: env.XCO_VERSION,
    specSource: env.XCO_SPEC_SOURCE,
    docsUrl: env.XCO_DOCS_URL,
    baseUrl: env.XCO_BASE_URL,
    token: env.XCO_TOKEN,
    tokenEnv: env.XCO_TOKEN_ENV,
    username: env.XCO_USERNAME,
    usernameEnv: env.XCO_USERNAME_ENV,
    password: env.XCO_PASSWORD,
    passwordEnv: env.XCO_PASSWORD_ENV,
    readonly: env.XCO_READONLY,
    bastionJumps: env.XCO_BASTION_JUMPS,
    bastionIdentityFile: env.XCO_BASTION_IDENTITY_FILE,
    bastionPassword: env.XCO_BASTION_PASSWORD,
    bastionPasswordEnv: env.XCO_BASTION_PASSWORD_ENV,
    bastionPasswords: env.XCO_BASTION_PASSWORDS,
    bastionPasswordsEnv: env.XCO_BASTION_PASSWORDS_ENV,
    bastionPasswordAuth: env.XCO_BASTION_PASSWORD_AUTH,
    bastionTargetHost: env.XCO_BASTION_TARGET_HOST,
    bastionTargetPort: env.XCO_BASTION_TARGET_PORT,
    bastionLocalPort: env.XCO_BASTION_LOCAL_PORT,
    bastionBindHost: env.XCO_BASTION_BIND_HOST,
    bastionStrictHostKeyChecking: env.XCO_BASTION_STRICT_HOST_KEY_CHECKING,
    tlsRejectUnauthorized: env.XCO_TLS_REJECT_UNAUTHORIZED,
  });

  return {
    cwd,
    xcoHome,
    configPath,
    sessionPath,
    manualSpecsDir,
    activeVersion: (merged.activeVersion as string | undefined) ?? null,
    specSource: (merged.specSource as string | undefined) ?? "official",
    docsUrl: (merged.docsUrl as string | undefined) ?? null,
    baseUrl: (merged.baseUrl as string | undefined) ?? null,
    token: (merged.token as string | undefined) ?? null,
    tokenEnv: (merged.tokenEnv as string | undefined) ?? null,
    username: (merged.username as string | undefined) ?? null,
    usernameEnv: (merged.usernameEnv as string | undefined) ?? null,
    password: (merged.password as string | undefined) ?? null,
    passwordEnv: (merged.passwordEnv as string | undefined) ?? null,
    readonly: parseBooleanish(
      merged.readonly,
      parseBooleanish(fileConfig.readonly, false),
    ),
    bastionJumps: (merged.bastionJumps as string | undefined) ?? null,
    bastionIdentityFile: (merged.bastionIdentityFile as string | undefined) ?? null,
    bastionPassword: (merged.bastionPassword as string | undefined) ?? null,
    bastionPasswordEnv: (merged.bastionPasswordEnv as string | undefined) ?? null,
    bastionPasswords: (merged.bastionPasswords as string | undefined) ?? null,
    bastionPasswordsEnv: (merged.bastionPasswordsEnv as string | undefined) ?? null,
    bastionPasswordAuth: parseBooleanish(
      merged.bastionPasswordAuth,
      parseBooleanish(fileConfig.bastionPasswordAuth, false),
    ),
    bastionTargetHost: (merged.bastionTargetHost as string | undefined) ?? null,
    bastionTargetPort:
      merged.bastionTargetPort !== undefined &&
      merged.bastionTargetPort !== null
        ? Number(merged.bastionTargetPort)
        : null,
    bastionLocalPort:
      merged.bastionLocalPort !== undefined && merged.bastionLocalPort !== null
        ? Number(merged.bastionLocalPort)
        : null,
    bastionBindHost: (merged.bastionBindHost as string | undefined) ?? null,
    bastionStrictHostKeyChecking: parseBooleanishNullable(
      merged.bastionStrictHostKeyChecking ??
        fileConfig.bastionStrictHostKeyChecking,
    ),
    tlsRejectUnauthorized: (merged.tlsRejectUnauthorized as string | undefined) ?? null,
  };
}

export async function saveConfig(config: XcoConfig, patch: Record<string, unknown>): Promise<XcoConfig> {
  const nextValue = mergeDefined(config as unknown as Record<string, unknown>, patch);
  await fs.mkdir(path.dirname(config.configPath), { recursive: true });
  await writeJson(config.configPath, {
    activeVersion: nextValue.activeVersion ?? null,
    specSource: nextValue.specSource ?? "official",
    docsUrl: nextValue.docsUrl ?? null,
    baseUrl: nextValue.baseUrl ?? null,
    tokenEnv: nextValue.tokenEnv ?? null,
    username: nextValue.username ?? null,
    usernameEnv: nextValue.usernameEnv ?? null,
    passwordEnv: nextValue.passwordEnv ?? null,
    readonly: Boolean(nextValue.readonly),
    bastionJumps: nextValue.bastionJumps ?? null,
    bastionIdentityFile: nextValue.bastionIdentityFile ?? null,
    bastionPasswordEnv: nextValue.bastionPasswordEnv ?? null,
    bastionPasswordsEnv: nextValue.bastionPasswordsEnv ?? null,
    bastionPasswordAuth: Boolean(nextValue.bastionPasswordAuth),
    bastionTargetHost: nextValue.bastionTargetHost ?? null,
    bastionTargetPort: nextValue.bastionTargetPort ?? null,
    bastionLocalPort: nextValue.bastionLocalPort ?? null,
    bastionBindHost: nextValue.bastionBindHost ?? null,
    bastionStrictHostKeyChecking:
      nextValue.bastionStrictHostKeyChecking === null ||
      nextValue.bastionStrictHostKeyChecking === undefined
        ? null
        : Boolean(nextValue.bastionStrictHostKeyChecking),
    tlsRejectUnauthorized: nextValue.tlsRejectUnauthorized ?? null,
  });

  return {
    ...config,
    ...Object.fromEntries(
      Object.entries(nextValue).filter(([, v]) => v !== undefined),
    ),
  } as XcoConfig;
}

export function resolveToken(config: XcoConfig, overrides: ConfigOverrides = {}): string | null {
  if (overrides.token) {
    return overrides.token;
  }

  if (config.token) {
    return config.token;
  }

  if (overrides.tokenEnv) {
    const envValue = process.env[overrides.tokenEnv];
    if (envValue) return envValue;
  }

  if (config.tokenEnv) {
    const envValue = process.env[config.tokenEnv];
    if (envValue) return envValue;
  }

  return null;
}

export function resolveUsername(config: XcoConfig, overrides: ConfigOverrides = {}): string | null {
  if (overrides.username) {
    return overrides.username;
  }

  if (config.username) {
    return config.username;
  }

  if (overrides.usernameEnv) {
    const envValue = process.env[overrides.usernameEnv];
    if (envValue) return envValue;
  }

  if (config.usernameEnv) {
    const envValue = process.env[config.usernameEnv];
    if (envValue) return envValue;
  }

  return null;
}

export function resolvePassword(config: XcoConfig, overrides: ConfigOverrides = {}): string | null {
  if (overrides.password) {
    return overrides.password;
  }

  if (config.password) {
    return config.password;
  }

  if (overrides.passwordEnv) {
    const envValue = process.env[overrides.passwordEnv];
    if (envValue) return envValue;
  }

  if (config.passwordEnv) {
    const envValue = process.env[config.passwordEnv];
    if (envValue) return envValue;
  }

  return null;
}

export function resolveCredentials(config: XcoConfig, overrides: ConfigOverrides = {}): { username: string | null; password: string | null } {
  return {
    username: resolveUsername(config, overrides),
    password: resolvePassword(config, overrides),
  };
}

import fs from "node:fs/promises";
import path from "node:path";

import { readJson, writeJson } from "./json.js";
import { mergeDefined, toAbsolutePath } from "./utils.js";

function parseBooleanish(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
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

export async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const xcoHome = toAbsolutePath(cwd, env.XCO_HOME ?? ".xco");
  const configPath = toAbsolutePath(cwd, env.XCO_CONFIG ?? path.join(xcoHome, "config.json"));
  const sessionPath = toAbsolutePath(cwd, env.XCO_SESSION_PATH ?? path.join(xcoHome, "session.json"));
  const manualSpecsDir = toAbsolutePath(cwd, env.XCO_SPECS_DIR ?? "specs");

  let fileConfig = {};
  try {
    fileConfig = await readJson(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
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
    bastionPasswordAuth: env.XCO_BASTION_PASSWORD_AUTH,
    bastionTargetHost: env.XCO_BASTION_TARGET_HOST,
    bastionTargetPort: env.XCO_BASTION_TARGET_PORT,
    bastionLocalPort: env.XCO_BASTION_LOCAL_PORT,
    bastionBindHost: env.XCO_BASTION_BIND_HOST,
    bastionStrictHostKeyChecking: env.XCO_BASTION_STRICT_HOST_KEY_CHECKING,
  });

  return {
    cwd,
    xcoHome,
    configPath,
    sessionPath,
    manualSpecsDir,
    activeVersion: merged.activeVersion ?? null,
    specSource: merged.specSource ?? "official",
    docsUrl: merged.docsUrl ?? null,
    baseUrl: merged.baseUrl ?? null,
    token: merged.token ?? null,
    tokenEnv: merged.tokenEnv ?? null,
    username: merged.username ?? null,
    usernameEnv: merged.usernameEnv ?? null,
    password: merged.password ?? null,
    passwordEnv: merged.passwordEnv ?? null,
    readonly: parseBooleanish(merged.readonly, parseBooleanish(fileConfig.readonly, false)),
    bastionJumps: merged.bastionJumps ?? null,
    bastionIdentityFile: merged.bastionIdentityFile ?? null,
    bastionPassword: merged.bastionPassword ?? null,
    bastionPasswordEnv: merged.bastionPasswordEnv ?? null,
    bastionPasswordAuth: parseBooleanish(
      merged.bastionPasswordAuth,
      parseBooleanish(fileConfig.bastionPasswordAuth, false),
    ),
    bastionTargetHost: merged.bastionTargetHost ?? null,
    bastionTargetPort:
      merged.bastionTargetPort !== undefined && merged.bastionTargetPort !== null
        ? Number(merged.bastionTargetPort)
        : null,
    bastionLocalPort:
      merged.bastionLocalPort !== undefined && merged.bastionLocalPort !== null
        ? Number(merged.bastionLocalPort)
        : null,
    bastionBindHost: merged.bastionBindHost ?? null,
    bastionStrictHostKeyChecking: parseBooleanish(
      merged.bastionStrictHostKeyChecking,
      parseBooleanish(fileConfig.bastionStrictHostKeyChecking, false),
    ),
  };
}

export async function saveConfig(config, patch) {
  const nextValue = mergeDefined(config, patch);
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
    bastionPasswordAuth: Boolean(nextValue.bastionPasswordAuth),
    bastionTargetHost: nextValue.bastionTargetHost ?? null,
    bastionTargetPort: nextValue.bastionTargetPort ?? null,
    bastionLocalPort: nextValue.bastionLocalPort ?? null,
    bastionBindHost: nextValue.bastionBindHost ?? null,
    bastionStrictHostKeyChecking: Boolean(nextValue.bastionStrictHostKeyChecking),
  });

  return nextValue;
}

export function resolveToken(config, overrides = {}) {
  if (overrides.token) {
    return overrides.token;
  }

  if (config.token) {
    return config.token;
  }

  if (overrides.tokenEnv && process.env[overrides.tokenEnv]) {
    return process.env[overrides.tokenEnv];
  }

  if (config.tokenEnv && process.env[config.tokenEnv]) {
    return process.env[config.tokenEnv];
  }

  return null;
}

export function resolveUsername(config, overrides = {}) {
  if (overrides.username) {
    return overrides.username;
  }

  if (config.username) {
    return config.username;
  }

  if (overrides.usernameEnv && process.env[overrides.usernameEnv]) {
    return process.env[overrides.usernameEnv];
  }

  if (config.usernameEnv && process.env[config.usernameEnv]) {
    return process.env[config.usernameEnv];
  }

  return null;
}

export function resolvePassword(config, overrides = {}) {
  if (overrides.password) {
    return overrides.password;
  }

  if (config.password) {
    return config.password;
  }

  if (overrides.passwordEnv && process.env[overrides.passwordEnv]) {
    return process.env[overrides.passwordEnv];
  }

  if (config.passwordEnv && process.env[config.passwordEnv]) {
    return process.env[config.passwordEnv];
  }

  return null;
}

export function resolveCredentials(config, overrides = {}) {
  return {
    username: resolveUsername(config, overrides),
    password: resolvePassword(config, overrides),
  };
}

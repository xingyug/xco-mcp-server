import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { XcoConfig } from "../src/types.js";
import { loadConfig, saveConfig, resolveToken, resolveUsername, resolvePassword, resolveCredentials } from "../src/lib/config.js";

test("saveConfig does not persist plaintext bastion passwords", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-config-test-"));
  const configPath = path.join(tempDir, "config.json");

  await saveConfig(
    { configPath } as XcoConfig,
    {
      activeVersion: "3.7.0",
      bastionPassword: "super-secret",
      bastionPasswordEnv: "XCO_BASTION_PASSWORD",
      bastionPasswordAuth: true,
    },
  );

  const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.bastionPassword, undefined);
  assert.equal(persisted.bastionPasswordEnv, "XCO_BASTION_PASSWORD");
  assert.equal(persisted.bastionPasswordAuth, true);
});

test("loadConfig reads env variables and applies defaults", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-config-test-"));
  try {
    const config = await loadConfig({
      cwd: tempDir,
      env: {
        XCO_BASE_URL: "https://example.com",
        XCO_USERNAME: "admin",
        XCO_VERSION: "3.7.0",
      },
    });
    assert.equal(config.baseUrl, "https://example.com");
    assert.equal(config.username, "admin");
    assert.equal(config.activeVersion, "3.7.0");
    assert.equal(config.specSource, "official");
    assert.equal(config.readonly, false);
    assert.equal(config.password, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig merges file config with env overrides", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-config-test-"));
  const xcoHome = path.join(tempDir, ".xco");
  await fs.mkdir(xcoHome, { recursive: true });
  const configPath = path.join(xcoHome, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    baseUrl: "https://file.example.com",
    username: "file-user",
    readonly: true,
  }));
  try {
    const config = await loadConfig({
      cwd: tempDir,
      env: {
        XCO_BASE_URL: "https://env.example.com",
      },
    });
    // Env overrides file
    assert.equal(config.baseUrl, "https://env.example.com");
    // File value preserved
    assert.equal(config.username, "file-user");
    assert.equal(config.readonly, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveToken returns override > config > env", () => {
  const config = {
    token: "config-token",
    tokenEnv: "MY_TOKEN_ENV",
  } as XcoConfig;

  // Override wins
  assert.equal(resolveToken(config, { token: "override-token" }), "override-token");
  // Config wins when no override
  assert.equal(resolveToken(config), "config-token");
  // Returns null when nothing set
  assert.equal(resolveToken({ token: null, tokenEnv: null } as XcoConfig), null);
});

test("resolveUsername returns override > config > env", () => {
  const config = {
    username: "config-user",
    usernameEnv: null,
  } as XcoConfig;
  assert.equal(resolveUsername(config, { username: "override-user" }), "override-user");
  assert.equal(resolveUsername(config), "config-user");
  assert.equal(resolveUsername({ username: null, usernameEnv: null } as XcoConfig), null);
});

test("resolvePassword returns override > config > env", () => {
  const config = {
    password: "config-pass",
    passwordEnv: null,
  } as XcoConfig;
  assert.equal(resolvePassword(config, { password: "override-pass" }), "override-pass");
  assert.equal(resolvePassword(config), "config-pass");
  assert.equal(resolvePassword({ password: null, passwordEnv: null } as XcoConfig), null);
});

test("resolveCredentials combines username and password resolution", () => {
  const config = {
    username: "admin",
    usernameEnv: null,
    password: "secret",
    passwordEnv: null,
  } as XcoConfig;
  const creds = resolveCredentials(config);
  assert.equal(creds.username, "admin");
  assert.equal(creds.password, "secret");
});

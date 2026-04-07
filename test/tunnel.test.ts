import test from "node:test";
import assert from "node:assert/strict";

import type { XcoConfig, TunnelSettings, ActiveTunnel } from "../src/types.js";
import {
  buildTunnelMatchPattern,
  buildSshTunnelCommand,
  buildSshTunnelSpec,
  deriveTunnelTarget,
  getTunnelSettings,
  parseBastionJumps,
  terminateTunnelProcess,
} from "../src/lib/tunnel.js";

test("parseBastionJumps supports comma-separated multi-hop values", () => {
  assert.deepEqual(parseBastionJumps("user@jump1,user@jump2,user@jump3"), [
    "user@jump1",
    "user@jump2",
    "user@jump3",
  ]);
});

test("deriveTunnelTarget falls back to the logical base URL host and port", () => {
  assert.deepEqual(
    deriveTunnelTarget(
      "https://xco.internal.example",
      getTunnelSettings({} as XcoConfig, {}),
    ),
    {
      targetHost: "xco.internal.example",
      targetPort: 443,
    },
  );
});

test("buildSshTunnelCommand emits ProxyJump and local forward arguments", () => {
  const command = buildSshTunnelCommand("https://xco.internal.example", {
    jumps: ["user@jump1", "user@jump2"],
    identityFile: "/tmp/id_rsa",
    bindHost: "127.0.0.1",
    localPort: 9443,
    targetHost: null,
    targetPort: null,
    strictHostKeyChecking: false,
    passwordAuth: false,
    password: null,
    passwords: [],
    explicitMultiPassword: false,
    passwordEnv: null,
  } as TunnelSettings);

  assert.equal(command.command, "ssh");
  assert.deepEqual(command.args, [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-i",
    "/tmp/id_rsa",
    "-J",
    "user@jump1",
    "-o",
    "StrictHostKeyChecking=no",
    "-L",
    "127.0.0.1:9443:xco.internal.example:443",
    "user@jump2",
  ]);
});

test("buildSshTunnelCommand uses ssh with password-auth compatible options", () => {
  const command = buildSshTunnelCommand("https://xco.internal.example", {
    jumps: ["ops@jump1"],
    identityFile: null,
    passwordAuth: true,
    password: "super-secret",
    passwords: ["super-secret"],
    explicitMultiPassword: false,
    passwordEnv: null,
    bindHost: "127.0.0.1",
    localPort: 9443,
    targetHost: null,
    targetPort: null,
    strictHostKeyChecking: true,
  } as TunnelSettings);

  assert.equal(command.command, "ssh");
  assert.deepEqual(command.args, [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "BatchMode=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-L",
    "127.0.0.1:9443:xco.internal.example:443",
    "ops@jump1",
  ]);
  assert.deepEqual(command.env, {});
});

test("getTunnelSettings resolves home-relative identity file paths", () => {
  const settings = getTunnelSettings(
    {
      cwd: "/tmp/project",
      bastionIdentityFile: "~/.ssh/id_ed25519",
    } as XcoConfig,
    {},
  );

  assert.match(settings.identityFile!, /\/\.ssh\/id_ed25519$/);
});

test("terminateTunnelProcess kills the detached process group when available", () => {
  const originalKill = process.kill;
  const calls: [number, string][] = [];

  process.kill = ((pid: number, signal: string) => {
    calls.push([pid, signal]);
    return true;
  }) as typeof process.kill;

  try {
    const child = {
      pid: 4321,
      kill(): boolean {
        throw new Error(
          "child.kill should not be used when process group kill succeeds",
        );
      },
    };

    assert.equal(terminateTunnelProcess(child as unknown as Parameters<typeof terminateTunnelProcess>[0]), true);
    assert.deepEqual(calls, [[-4321, "SIGTERM"]]);
  } finally {
    process.kill = originalKill;
  }
});

test("terminateTunnelProcess falls back to child.kill when pid is unavailable", () => {
  const calls: string[] = [];
  const child = {
    pid: null as number | null,
    kill(signal: string): boolean {
      calls.push(signal);
      return true;
    },
  };

  assert.equal(terminateTunnelProcess(child as unknown as Parameters<typeof terminateTunnelProcess>[0]), true);
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("buildTunnelMatchPattern matches the unique local forward tuple", () => {
  assert.equal(
    buildTunnelMatchPattern({
      bindHost: "127.0.0.1",
      localPort: 9443,
      targetHost: "10.20.30.40",
      targetPort: 8080,
    } as ActiveTunnel),
    String.raw`ssh .* -L 127\.0\.0\.1:9443:10\.20\.30\.40:8080( |$)`,
  );
});

// --- Per-hop password tests ---

test("getTunnelSettings returns single password without explicitMultiPassword", () => {
  const settings = getTunnelSettings(
    {
      bastionJumps: "user@hop1,user@hop2",
      bastionPassword: "shared-pass",
      bastionPasswordAuth: true,
    } as unknown as XcoConfig,
    {},
  );
  assert.deepEqual(settings.passwords, ["shared-pass"]);
  assert.equal(settings.explicitMultiPassword, false);
  assert.equal(settings.password, "shared-pass");
});

test("getTunnelSettings returns explicit multi-password with explicitMultiPassword flag", () => {
  const settings = getTunnelSettings(
    {
      bastionJumps: "user@hop1,user@hop2",
      bastionPasswords: "pass1,pass2",
      bastionPasswordAuth: true,
    } as unknown as XcoConfig,
    {},
  );
  assert.deepEqual(settings.passwords, ["pass1", "pass2"]);
  assert.equal(settings.explicitMultiPassword, true);
});

test("getTunnelSettings throws on password count mismatch", () => {
  assert.throws(
    () =>
      getTunnelSettings(
        {
          bastionJumps: "user@hop1,user@hop2,user@hop3",
          bastionPasswords: "pass1,pass2",
          bastionPasswordAuth: true,
        } as unknown as XcoConfig,
        {},
      ),
    /password count mismatch.*2.*3/i,
  );
});

test("getTunnelSettings throws on empty password in explicit multi-password", () => {
  assert.throws(
    () =>
      getTunnelSettings(
        {
          bastionJumps: "user@hop1,user@hop2",
          bastionPasswords: "pass1,",
          bastionPasswordAuth: true,
        } as unknown as XcoConfig,
        {},
      ),
    /empty/i,
  );
});

test("getTunnelSettings resolves per-hop passwords from env vars", () => {
  const envKey1 = "XCO_TEST_HOP_PASS_A";
  const envKey2 = "XCO_TEST_HOP_PASS_B";
  process.env[envKey1] = "envPass1";
  process.env[envKey2] = "envPass2";
  try {
    const settings = getTunnelSettings(
      {
        bastionJumps: "user@hop1,user@hop2",
        bastionPasswordsEnv: `${envKey1},${envKey2}`,
        bastionPasswordAuth: true,
      } as unknown as XcoConfig,
      {},
    );
    assert.deepEqual(settings.passwords, ["envPass1", "envPass2"]);
    assert.equal(settings.explicitMultiPassword, true);
  } finally {
    delete process.env[envKey1];
    delete process.env[envKey2];
  }
});

test("getTunnelSettings throws when env var not set for per-hop passwords", () => {
  const envKey = "XCO_TEST_MISSING_" + Date.now();
  assert.throws(
    () =>
      getTunnelSettings(
        {
          bastionJumps: "user@hop1",
          bastionPasswordsEnv: envKey,
          bastionPasswordAuth: true,
        } as unknown as XcoConfig,
        {},
      ),
    /not set/i,
  );
});

test("buildSshTunnelSpec accepts plural-only passwords without singular password", () => {
  const settings = getTunnelSettings(
    {
      bastionJumps: "user@hop1,user@hop2",
      bastionPasswords: "pass1,pass2",
      bastionPasswordAuth: true,
    } as unknown as XcoConfig,
    {},
  );
  // Should NOT throw even though settings.password is null
  const spec = buildSshTunnelSpec("https://xco.example.com", {
    ...settings,
    localPort: 9999,
  });
  assert.equal(spec.passwordAuth, true);
  assert.equal(spec.finalHop, "user@hop2");
});

test("buildSshTunnelSpec rejects passwordAuth with no password at all", () => {
  assert.throws(
    () =>
      buildSshTunnelSpec("https://xco.example.com", {
        jumps: ["user@hop1"],
        passwordAuth: true,
        password: null,
        passwords: [],
        explicitMultiPassword: false,
        passwordEnv: null,
        identityFile: null,
        bindHost: "127.0.0.1",
        localPort: 9999,
        targetHost: null,
        targetPort: null,
        strictHostKeyChecking: null,
      } as TunnelSettings),
    /no bastion password/i,
  );
});

// --- TLS config tests ---

test("loadConfig reads XCO_TLS_REJECT_UNAUTHORIZED", async () => {
  const { loadConfig } = await import("../src/lib/config.js");
  process.env.XCO_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const config = await loadConfig({});
    assert.equal(config.tlsRejectUnauthorized, "0");
  } finally {
    delete process.env.XCO_TLS_REJECT_UNAUTHORIZED;
  }
});

test("getTunnelSettings trims whitespace from per-hop passwords", () => {
  const settings = getTunnelSettings(
    {
      bastionJumps: "user@hop1,user@hop2",
      bastionPasswords: " pass1 , pass2 ",
      bastionPasswordAuth: true,
    } as unknown as XcoConfig,
    {},
  );
  assert.deepEqual(settings.passwords, ["pass1", "pass2"]);
});

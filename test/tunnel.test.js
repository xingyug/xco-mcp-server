import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTunnelMatchPattern,
  buildSshTunnelCommand,
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
  assert.deepEqual(deriveTunnelTarget("https://xco.internal.example", getTunnelSettings({}, {})), {
    targetHost: "xco.internal.example",
    targetPort: 443,
  });
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
  });

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
    bindHost: "127.0.0.1",
    localPort: 9443,
    targetHost: null,
    targetPort: null,
    strictHostKeyChecking: true,
  });

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
    },
    {},
  );

  assert.match(settings.identityFile, /\/\.ssh\/id_ed25519$/);
});

test("terminateTunnelProcess kills the detached process group when available", () => {
  const originalKill = process.kill;
  const calls = [];

  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };

  try {
    const child = {
      pid: 4321,
      kill() {
        throw new Error("child.kill should not be used when process group kill succeeds");
      },
    };

    assert.equal(terminateTunnelProcess(child), true);
    assert.deepEqual(calls, [[-4321, "SIGTERM"]]);
  } finally {
    process.kill = originalKill;
  }
});

test("terminateTunnelProcess falls back to child.kill when pid is unavailable", () => {
  const calls = [];
  const child = {
    pid: null,
    kill(signal) {
      calls.push(signal);
      return true;
    },
  };

  assert.equal(terminateTunnelProcess(child), true);
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("buildTunnelMatchPattern matches the unique local forward tuple", () => {
  assert.equal(
    buildTunnelMatchPattern({
      bindHost: "127.0.0.1",
      localPort: 9443,
      targetHost: "10.20.30.40",
      targetPort: 8080,
    }),
    String.raw`ssh .* -L 127\.0\.0\.1:9443:10\.20\.30\.40:8080( |$)`,
  );
});

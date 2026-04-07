import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { toAbsolutePath } from "./utils.js";

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
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

  return null;
}

function resolveBastionPassword(config, overrides = {}) {
  if (overrides.bastionPassword) {
    return overrides.bastionPassword;
  }

  if (config.bastionPassword) {
    return config.bastionPassword;
  }

  if (
    overrides.bastionPasswordEnv &&
    process.env[overrides.bastionPasswordEnv]
  ) {
    return process.env[overrides.bastionPasswordEnv];
  }

  if (config.bastionPasswordEnv && process.env[config.bastionPasswordEnv]) {
    return process.env[config.bastionPasswordEnv];
  }

  return null;
}

function resolveBastionPasswords(config, overrides = {}) {
  // Per-hop passwords from explicit values (comma-separated)
  const rawPasswords =
    overrides.bastionPasswords ?? config.bastionPasswords ?? null;
  if (rawPasswords) {
    const list = (
      Array.isArray(rawPasswords)
        ? rawPasswords
        : String(rawPasswords).split(",")
    ).map((p) => String(p).trim());
    if (list.length > 0 && list.some(Boolean)) {
      return { passwords: list, explicit: true };
    }
  }

  // Per-hop passwords from env var names (comma-separated names)
  const rawEnvNames =
    overrides.bastionPasswordsEnv ?? config.bastionPasswordsEnv ?? null;
  if (rawEnvNames) {
    const names = (
      Array.isArray(rawEnvNames)
        ? rawEnvNames
        : String(rawEnvNames).split(",")
    )
      .map((n) => String(n).trim())
      .filter(Boolean);
    if (names.length > 0) {
      const resolved = names.map((name) => process.env[name] ?? "");
      const missing = names.filter((name) => !process.env[name]);
      if (missing.length > 0) {
        throw new Error(
          `Bastion password env var(s) not set: ${missing.join(", ")}`,
        );
      }
      return { passwords: resolved, explicit: true };
    }
  }

  // Fall back to single password (not explicit multi-password)
  const single = resolveBastionPassword(config, overrides);
  if (single) {
    return { passwords: [single], explicit: false };
  }

  return { passwords: [], explicit: false };
}

export function parseBastionJumps(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getTunnelSettings(config, overrides = {}) {
  const jumps = parseBastionJumps(overrides.bastionJumps ?? config.bastionJumps);
  const resolved = resolveBastionPasswords(config, overrides);

  // Validate password count: must be 0, 1, or exactly jumps.length
  if (
    resolved.passwords.length > 1 &&
    jumps.length > 0 &&
    resolved.passwords.length !== jumps.length
  ) {
    throw new Error(
      `Bastion password count mismatch: ${resolved.passwords.length} password(s) provided for ${jumps.length} jump(s). ` +
        "Provide exactly 1 shared password or one password per hop.",
    );
  }

  // Validate no empty entries in explicit multi-password
  if (resolved.explicit && resolved.passwords.length > 1) {
    const emptyIdx = resolved.passwords.findIndex((p) => !p);
    if (emptyIdx !== -1) {
      throw new Error(
        `Bastion password at index ${emptyIdx} is empty. All per-hop passwords must be non-empty.`,
      );
    }
  }

  return {
    jumps,
    identityFile: toAbsolutePath(
      config.cwd ?? process.cwd(),
      overrides.bastionIdentityFile ?? config.bastionIdentityFile ?? null,
    ),
    passwordAuth:
      parseBoolean(overrides.bastionPasswordAuth) ??
      parseBoolean(config.bastionPasswordAuth) ??
      false,
    password: resolveBastionPassword(config, overrides),
    passwords: resolved.passwords,
    explicitMultiPassword: resolved.explicit && resolved.passwords.length > 1,
    passwordEnv:
      overrides.bastionPasswordEnv ?? config.bastionPasswordEnv ?? null,
    targetHost: overrides.bastionTargetHost ?? config.bastionTargetHost ?? null,
    targetPort: overrides.bastionTargetPort ?? config.bastionTargetPort ?? null,
    localPort: overrides.bastionLocalPort ?? config.bastionLocalPort ?? null,
    bindHost:
      overrides.bastionBindHost ?? config.bastionBindHost ?? "127.0.0.1",
    strictHostKeyChecking:
      parseBoolean(overrides.bastionStrictHostKeyChecking) ??
      parseBoolean(config.bastionStrictHostKeyChecking) ??
      null,
  };
}

export function hasTunnelConfigured(config, overrides = {}) {
  return getTunnelSettings(config, overrides).jumps.length > 0;
}

export function deriveTunnelTarget(logicalBaseUrl, settings) {
  const url = new URL(logicalBaseUrl);
  const parsedPort = url.port ? Number(url.port) : null;
  return {
    targetHost: settings.targetHost ?? url.hostname,
    targetPort: Number(
      settings.targetPort ??
        parsedPort ??
        (url.protocol === "http:" ? 80 : 443),
    ),
  };
}

export function buildTunnelKey(logicalBaseUrl, settings) {
  return JSON.stringify({
    logicalBaseUrl,
    jumps: settings.jumps,
    identityFile: settings.identityFile,
    passwordAuth: Boolean(settings.passwordAuth),
    targetHost: settings.targetHost,
    targetPort: settings.targetPort,
    localPort: settings.localPort,
    bindHost: settings.bindHost,
    strictHostKeyChecking: settings.strictHostKeyChecking,
  });
}

export function buildSshTunnelSpec(logicalBaseUrl, settings) {
  if (settings.jumps.length === 0) {
    throw new Error("No bastion jumps are configured.");
  }

  if (
    settings.passwordAuth &&
    !settings.password &&
    !(settings.passwords && settings.passwords.length > 0)
  ) {
    throw new Error(
      "Bastion password auth is enabled, but no bastion password or bastion password env value is available.",
    );
  }

  const { targetHost, targetPort } = deriveTunnelTarget(
    logicalBaseUrl,
    settings,
  );
  const finalHop = settings.jumps.at(-1);
  const proxyJump =
    settings.jumps.length > 1 ? settings.jumps.slice(0, -1).join(",") : null;

  return {
    finalHop,
    proxyJump,
    targetHost,
    targetPort,
    bindHost: settings.bindHost ?? "127.0.0.1",
    localPort: settings.localPort ?? null,
    identityFile: settings.identityFile ?? null,
    passwordAuth: Boolean(settings.passwordAuth),
    strictHostKeyChecking: settings.strictHostKeyChecking,
  };
}

export function buildSshTunnelCommand(logicalBaseUrl, settings) {
  const spec = buildSshTunnelSpec(logicalBaseUrl, settings);
  if (!spec.localPort) {
    throw new Error("buildSshTunnelCommand requires a concrete localPort.");
  }

  const args = [
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];

  if (spec.passwordAuth) {
    args.push("-o", "BatchMode=no");
  }

  if (spec.identityFile) {
    args.push("-i", spec.identityFile);
  }

  if (spec.proxyJump) {
    args.push("-J", spec.proxyJump);
  }

  if (spec.strictHostKeyChecking !== null) {
    args.push(
      "-o",
      `StrictHostKeyChecking=${spec.strictHostKeyChecking ? "yes" : "no"}`,
    );
  }

  args.push(
    "-L",
    `${spec.bindHost}:${spec.localPort}:${spec.targetHost}:${spec.targetPort}`,
    spec.finalHop,
  );

  return {
    command: "ssh",
    args,
    env: {},
    spec,
  };
}

function createAskpassHelper(passwords, jumps) {
  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "xco-askpass-"));

  if (Array.isArray(passwords) && passwords.length > 1 && Array.isArray(jumps)) {
    // Prompt-aware: match user@host from SSH prompt against jump hosts
    const helperPath = path.join(helperDir, "askpass.sh");
    fs.writeFileSync(
      helperPath,
      [
        "#!/bin/sh",
        'PROMPT="${1:-}"',
        "",
        '# Extract user@host from prompt like "user@host\'s password: "',
        "TARGET=$(printf '%s' \"$PROMPT\" | sed -n \"s/^\\([^']*\\)'s password.*/\\1/p\")",
        "",
        'if [ -n "$TARGET" ] && [ -n "$XCO_BASTION_ASKPASS_KEYS" ]; then',
        '  OLD_IFS="$IFS"',
        "  IFS='|'",
        "  IDX=0",
        "  for KEY in $XCO_BASTION_ASKPASS_KEYS; do",
        '    if [ "$KEY" = "$TARGET" ]; then',
        '      eval "PASS=\\$XCO_BASTION_ASKPASS_${IDX}"',
        '      if [ -n "$PASS" ]; then',
        "        printf '%s\\n' \"$PASS\"",
        "        exit 0",
        "      fi",
        "    fi",
        "    IDX=$((IDX + 1))",
        "  done",
        '  IFS="$OLD_IFS"',
        "fi",
        "",
        "# In multi-password mode, fail if no match found rather than sending wrong password",
        'echo "xco-askpass: no matching hop for prompt: $PROMPT" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    fs.chmodSync(helperPath, 0o700);

    // Build env vars: keys mapping + per-hop passwords
    const env = {
      DISPLAY: process.env.DISPLAY ?? "codex:0",
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      XCO_BASTION_ASKPASS_KEYS: jumps.join("|"),
      XCO_BASTION_ASKPASS_PASSWORD: passwords[0],
    };
    for (let i = 0; i < passwords.length; i++) {
      env[`XCO_BASTION_ASKPASS_${i}`] = passwords[i];
    }

    return {
      path: helperPath,
      env,
      cleanup() {
        fs.rmSync(helperDir, { recursive: true, force: true });
      },
    };
  }

  // Single password: simple echo helper (backward compatible)
  const helperPath = path.join(helperDir, "askpass.sh");
  fs.writeFileSync(
    helperPath,
    "#!/bin/sh\nprintf '%s\\n' \"$XCO_BASTION_ASKPASS_PASSWORD\"\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );
  fs.chmodSync(helperPath, 0o700);

  return {
    path: helperPath,
    env: {
      DISPLAY: process.env.DISPLAY ?? "codex:0",
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
    },
    cleanup() {
      fs.rmSync(helperDir, { recursive: true, force: true });
    },
  };
}

export function terminateTunnelProcess(child, signal = "SIGTERM") {
  if (!child) {
    return false;
  }

  const pid = Number.isInteger(child.pid) ? child.pid : null;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  try {
    child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

export function buildTunnelMatchPattern(tunnel) {
  const localForward = `${tunnel.bindHost}:${tunnel.localPort}:${tunnel.targetHost}:${tunnel.targetPort}`;
  return `ssh .* -L ${escapeRegex(localForward)}( |$)`;
}

export function stopSshTunnel(tunnel, signal = "SIGTERM") {
  return terminateTunnelProcess(tunnel?.child, signal);
}

export async function allocateLocalPort(bindHost = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, bindHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForLocalPort(bindHost, localPort, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: bindHost, port: localPort });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `SSH tunnel did not open ${bindHost}:${localPort} before timeout.`,
  );
}

export async function startSshTunnel(logicalBaseUrl, settings) {
  const localPort =
    settings.localPort ??
    (await allocateLocalPort(settings.bindHost ?? "127.0.0.1"));
  const tunnelCommand = buildSshTunnelCommand(logicalBaseUrl, {
    ...settings,
    localPort,
  });

  const useMultiPassword =
    tunnelCommand.spec.passwordAuth && settings.explicitMultiPassword;

  const effectivePassword =
    settings.password ?? settings.passwords?.[0] ?? null;

  const askpassHelper = tunnelCommand.spec.passwordAuth
    ? createAskpassHelper(
        useMultiPassword ? settings.passwords : null,
        useMultiPassword ? settings.jumps : null,
      )
    : null;

  const child = spawn(tunnelCommand.command, tunnelCommand.args, {
    env: {
      ...process.env,
      ...tunnelCommand.env,
      ...(askpassHelper?.env ?? {}),
      ...(tunnelCommand.spec.passwordAuth && !useMultiPassword
        ? {
            XCO_BASTION_ASKPASS_PASSWORD: effectivePassword,
          }
        : {}),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const cleanupHelper = () => {
    try {
      askpassHelper?.cleanup();
    } catch {}
  };
  child.once("exit", cleanupHelper);

  try {
    await Promise.race([
      waitForLocalPort(
        tunnelCommand.spec.bindHost,
        tunnelCommand.spec.localPort,
        5000,
      ),
      new Promise((_, reject) => {
        child.once("error", (error) => {
          reject(error);
        });
      }),
      new Promise((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `SSH tunnel exited before becoming ready (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.trim()}`,
            ),
          );
        });
      }),
    ]);
  } catch (error) {
    terminateTunnelProcess(child, "SIGTERM");
    cleanupHelper();
    throw error;
  }

  return {
    child,
    localPort: tunnelCommand.spec.localPort,
    bindHost: tunnelCommand.spec.bindHost,
    logicalBaseUrl,
    targetHost: tunnelCommand.spec.targetHost,
    targetPort: tunnelCommand.spec.targetPort,
    cleanup: cleanupHelper,
  };
}

#!/usr/bin/env node

import { createRuntime } from "./lib/runtime.js";
import { parseJsonText } from "./lib/json.js";

function parseFlags(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

function usage() {
  return `Usage:
  xco-call setup --version 3.7.0 [--base-url https://xco.company.example] [--spec-source official|instance|auto] [--docs-url https://xco.company.example/docs/] [--readonly true]
  xco-call use-version --version 3.7.0 [--base-url https://xco.company.example] [--readonly true]
  xco-call versions [--remote]
  xco-call describe
  xco-call auth login --username admin --password 'secret' [--persist-config true]
  xco-call auth status
  xco-call auth logout
  xco-call tools
  xco-call call <tool-name> --json '{"name":"Tenant-1"}'
  xco-call raw --method GET --service-prefix /v1/tenant --path /tenants
  xco-call use-version --version 3.7.0 --base-url https://xco.company.example --bastion-jumps ops@jump1,ops@jump2
  XCO_BASTION_PASSWORD=secret xco-call use-version --version 3.7.0 --bastion-password-auth true --bastion-password-env XCO_BASTION_PASSWORD
`;
}

function sharedConnectionFlags(flags) {
  return {
    specSource: flags["spec-source"],
    docsUrl: flags["docs-url"],
    baseUrl: flags["base-url"],
    username: flags.username,
    usernameEnv: flags["username-env"],
    passwordEnv: flags["password-env"],
    tokenEnv: flags["token-env"],
    readonly: flags.readonly === undefined ? undefined : parseBoolean(flags.readonly),
    bastionJumps: flags["bastion-jumps"],
    bastionIdentityFile: flags["bastion-identity-file"],
    bastionPasswordAuth:
      flags["bastion-password-auth"] === undefined ? undefined : parseBoolean(flags["bastion-password-auth"]),
    bastionPassword: flags["bastion-password"],
    bastionPasswordEnv: flags["bastion-password-env"],
    bastionTargetHost: flags["bastion-target-host"],
    bastionTargetPort:
      flags["bastion-target-port"] === undefined ? undefined : Number.parseInt(flags["bastion-target-port"], 10),
    bastionLocalPort:
      flags["bastion-local-port"] === undefined ? undefined : Number.parseInt(flags["bastion-local-port"], 10),
    bastionBindHost: flags["bastion-bind-host"],
    bastionStrictHostKeyChecking:
      flags["bastion-strict-host-key-checking"] === undefined
        ? undefined
        : parseBoolean(flags["bastion-strict-host-key-checking"]),
  };
}

async function main() {
  const runtime = await createRuntime();
  try {
    const [command, ...rest] = process.argv.slice(2);
    const { positional, flags } = parseFlags(rest);

    if (!command || flags.help || flags.h) {
      process.stdout.write(usage());
      return;
    }

    if (command === "setup") {
      const result = await runtime.setupVersion({
        version: flags.version,
        overwrite: parseBoolean(flags.overwrite),
        activate: parseBoolean(flags.activate, true),
        ...sharedConnectionFlags(flags),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "use-version") {
      const result = await runtime.useVersion({
        version: flags.version,
        ...sharedConnectionFlags(flags),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "versions") {
      const result = await runtime.callMetaTool("xco_list_versions", {
        remote: parseBoolean(flags.remote),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "describe") {
      const result = await runtime.describeBundle();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "auth") {
      const subcommand = positional[0];
      if (subcommand === "login") {
        const result = await runtime.callMetaTool("xco_auth_login", {
          ...sharedConnectionFlags(flags),
          username: flags.username,
          password: flags.password,
          persistConfig: parseBoolean(flags["persist-config"]),
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      if (subcommand === "status") {
        const result = await runtime.callMetaTool("xco_auth_status", {
          ...sharedConnectionFlags(flags),
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      if (subcommand === "logout") {
        const result = await runtime.callMetaTool("xco_auth_logout", {
          ...sharedConnectionFlags(flags),
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      throw new Error(`Unknown auth subcommand "${subcommand}".\n${usage()}`);
    }

    if (command === "tools") {
      process.stdout.write(`${JSON.stringify(runtime.getTools(), null, 2)}\n`);
      return;
    }

    if (command === "call") {
      const toolName = positional[0];
      if (!toolName) {
        throw new Error("Missing tool name for `call`.");
      }

      const input = flags.json ? parseJsonText(flags.json, "tool arguments") : {};
      const result = await runtime.callTool(toolName, input);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "raw") {
      const input = {
        method: flags.method,
        servicePrefix: flags["service-prefix"],
        path: flags.path,
        authenticate: flags.authenticate === undefined ? undefined : parseBoolean(flags.authenticate),
        query: flags.query ? parseJsonText(flags.query, "query JSON") : undefined,
        headers: flags.headers ? parseJsonText(flags.headers, "headers JSON") : undefined,
        body: flags.body ? parseJsonText(flags.body, "body JSON") : undefined,
        ...sharedConnectionFlags(flags),
      };
      const result = await runtime.callMetaTool("xco_raw_request", input);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown command "${command}".\n${usage()}`);
  } finally {
    runtime.closeTunnels();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

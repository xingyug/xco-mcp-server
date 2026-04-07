# Agent Guide

Instructions for AI agents and coding assistants working with this repository.
This file is for repository contributors. For operator-facing bootstrap and runtime setup, start with [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Project Overview

Zero-dependency Node.js (>=22) ESM project, written in TypeScript. Source lives in `src/*.ts` and compiles to `dist/src/*.js`. Four entry points share the same runtime:

| Entry Point         | Source                         | Compiled Output                     | Purpose                                                 |
| ------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------------- |
| MCP stdio           | `src/server.ts`                | `dist/src/server.js`                | JSON-RPC stdio for MCP-compatible agents (`2024-11-05`) |
| MCP Streamable HTTP | `src/http-server.ts` → `/mcp`  | `dist/src/http-server.js` → `/mcp`  | Remote MCP over HTTP (`2025-03-26`)                     |
| CLI                 | `src/cli.ts`                   | `dist/src/cli.js`                   | Direct command-line usage and skill wrappers            |
| HTTP + SSE          | `src/http-server.ts`           | `dist/src/http-server.js`           | REST API with streaming progress events                 |

For operator-facing setup, start with [docs/QUICKSTART.md](docs/QUICKSTART.md).
Use [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for bastion, readonly, and runtime-mode details.
Use [docs/AUTH.md](docs/AUTH.md) for token and username/password flows.

## Architecture

TypeScript source is in `src/`, compiled JavaScript output is in `dist/src/`. Always run `npm run build` after making source changes.

```
src/
├── server.ts              # MCP stdio entry (thin wrapper)
├── mcp-server.ts          # MCP JSON-RPC framing and dispatch (stdio)
├── mcp-http-transport.ts  # MCP Streamable HTTP transport handler
├── cli.ts                 # CLI argument parsing and command dispatch
├── http-server.ts         # HTTP + SSE server (REST API + /mcp endpoint)
└── lib/
    ├── runtime.ts         # Core orchestrator (XcoRuntime class, tool routing)
    ├── mcp-dispatch.ts    # Shared MCP dispatch logic (used by stdio + HTTP)
    ├── config.ts          # Config loading, saving, credential resolution
    ├── auth.ts            # JWT decode, session CRUD, token masking
    ├── downloader.ts      # Spec discovery and download from docs sites
    ├── openapi.ts         # OpenAPI spec parsing, operation/tool generation
    ├── tunnel.ts          # SSH tunnel management, bastion chain building
    ├── xco-client.ts      # HTTP client for XCO API operations
    ├── utils.ts           # Shared constants and helpers
    ├── json.ts            # JSON file I/O utilities
    └── event-bus.ts       # Simple pub/sub for SSE streaming
```

## Key Concepts

- **XcoRuntime** (`src/lib/runtime.ts`): Central class that manages config, loaded operations, session cache, and SSH tunnels. Static `XcoRuntime.instances` Set tracks all instances for process-exit cleanup.
- **META_TOOLS**: 8 built-in tools (`xco_setup_version`, `xco_use_version`, `xco_list_versions`, `xco_describe_bundle`, `xco_auth_login`, `xco_auth_status`, `xco_auth_logout`, `xco_raw_request`). Routing uses `META_TOOL_NAMES` Set.
- **Generated tools**: Created from OpenAPI specs. Named `<service_slug>__<operation_id>` (e.g., `tenant__gettenants`).
- **Config storage**: `$XCO_HOME/config.json` for settings and `$XCO_HOME/session.json` for auth tokens. If `XCO_HOME` is unset, the default is `.xco/` under the current working directory. Specs are cached under `$XCO_HOME/versions/<version>/`.
- **SSH tunnels**: Managed via `child_process.spawn` with `SSH_ASKPASS` helper scripts for password auth. Multi-hop supported via `ssh -J`.

## Build and Test

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Run all unit tests (Node.js built-in test runner)
npm test

# Run a single test file
node --test dist/test/auth.test.js
```

`npm test` should pass. The unit tests live under `test/*.test.ts` (compiled to `dist/test/*.test.js`) and use no external services. They rely on synthetic OpenAPI specs plus local downloader/runtime fixtures.

## E2E Testing

For a first-time operator bootstrap, use [docs/QUICKSTART.md](docs/QUICKSTART.md).

The integration E2E test requires a Kubernetes cluster with SSH-accessible nodes:

```bash
export KUBECONFIG=/path/to/kubeconfig
export XCO_E2E_BASTION_JUMPS='user@jump-host'
export XCO_BASTION_PASSWORD='bastion-password'
export XCO_PASSWORD='secret'
bash scripts/e2e-auth-mock.sh
```

This deploys `examples/mock-xco-k8s.yaml`, tests setup, auth, tool calls, and readonly mode through an SSH bastion tunnel.

## Common Tasks

### Adding a new meta tool

1. Add the tool definition to `META_TOOLS` array in `src/lib/runtime.ts`
2. Add the tool name to `META_TOOL_NAMES` Set (same file)
3. Implement the handler in `callMetaTool()` method
4. Add CLI command mapping in `src/cli.ts` if needed
5. Add HTTP route in `src/http-server.ts` if needed

### Modifying OpenAPI tool generation

Tool generation logic is in `src/lib/openapi.ts`:

- `buildToolsFromSpec()` — main entry point
- `buildOperationTool()` — per-operation tool builder
- `buildInputSchema()` — JSON Schema for tool arguments

### Modifying config

Config shape is defined in `src/lib/config.ts`:

- `loadConfig()` — merges file config, env vars, and overrides
- `saveConfig()` — persists to `$XCO_HOME/config.json` (default `.xco/config.json` under the current working directory, never writes plaintext passwords)

## Code Style

- Pure ESM (`"type": "module"`), written in TypeScript
- Zero runtime dependencies
- Node.js >=22 built-in APIs only (`node:fs`, `node:http`, `node:crypto`, etc.)
- Comments only where behavior is non-obvious
- Errors include context (file paths, operation names) for debuggability

## Important Patterns

- **Credential safety**: `saveConfig()` strips plaintext passwords before writing. Only env var names are persisted.
- **Readonly mode**: `config.readonly = true` filters generated tools to read-only operations and blocks write raw requests.
- **Tunnel lifecycle**: Tunnels are opened on first API call and reused. `closeTunnels()` cleans up all tunnels, session cache, and instance tracking.
- **Session refresh**: Auth tokens are automatically refreshed using the cached refresh token when the access token expires.

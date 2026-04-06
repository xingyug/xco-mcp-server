# Agent Guide

Instructions for AI agents and coding assistants working with this repository.

## Project Overview

Zero-dependency Node.js (>=22) ESM project. Three entry points share the same runtime:

| Entry Point | File | Purpose |
|---|---|---|
| MCP stdio | `src/server.js` | JSON-RPC stdio for MCP-compatible agents |
| CLI | `src/cli.js` | Direct command-line usage and skill wrappers |
| HTTP + SSE | `src/http-server.js` | REST API with streaming progress events |

## Architecture

```
src/
├── server.js              # MCP stdio entry (thin wrapper)
├── mcp-server.js          # MCP JSON-RPC framing and dispatch
├── cli.js                 # CLI argument parsing and command dispatch
├── http-server.js         # HTTP + SSE server
└── lib/
    ├── runtime.js         # Core orchestrator (XcoRuntime class, tool routing)
    ├── config.js           # Config loading, saving, credential resolution
    ├── auth.js             # JWT decode, session CRUD, token masking
    ├── downloader.js       # Spec discovery and download from docs sites
    ├── openapi.js          # OpenAPI spec parsing, operation/tool generation
    ├── tunnel.js           # SSH tunnel management, bastion chain building
    ├── xco-client.js       # HTTP client for XCO API operations
    ├── utils.js            # Shared constants and helpers
    ├── json.js             # JSON file I/O utilities
    └── event-bus.js        # Simple pub/sub for SSE streaming
```

## Key Concepts

- **XcoRuntime** (`src/lib/runtime.js`): Central class that manages config, loaded operations, session cache, and SSH tunnels. Static `XcoRuntime.instances` Set tracks all instances for process-exit cleanup.
- **META_TOOLS**: 8 built-in tools (`xco_setup_version`, `xco_use_version`, `xco_list_versions`, `xco_describe_bundle`, `xco_auth_login`, `xco_auth_status`, `xco_auth_logout`, `xco_raw_request`). Routing uses `META_TOOL_NAMES` Set.
- **Generated tools**: Created from OpenAPI specs. Named `<service_slug>__<operation_id>` (e.g., `tenant__gettenants`).
- **Config storage**: `~/.xco/config.json` for settings, `~/.xco/session.json` for auth tokens. Specs cached under `~/.xco/versions/<version>/`.
- **SSH tunnels**: Managed via `child_process.spawn` with `SSH_ASKPASS` helper scripts for password auth. Multi-hop supported via `ssh -J`.

## Build and Test

```bash
# Install (no dependencies to fetch, but validates package.json)
npm install

# Run all unit tests (Node.js built-in test runner)
npm test

# Run a single test file
node --test test/auth.test.js
```

All 21 tests should pass. Tests use no external services — they mock HTTP via a local fixture server and use synthetic OpenAPI specs from `specs/`.

## E2E Testing

The E2E test requires a Kubernetes cluster with SSH-accessible nodes:

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

1. Add the tool definition to `META_TOOLS` array in `src/lib/runtime.js`
2. Add the tool name to `META_TOOL_NAMES` Set (same file)
3. Implement the handler in `callMetaTool()` method
4. Add CLI command mapping in `src/cli.js` if needed
5. Add HTTP route in `src/http-server.js` if needed

### Modifying OpenAPI tool generation

Tool generation logic is in `src/lib/openapi.js`:
- `buildToolsFromSpec()` — main entry point
- `buildOperationTool()` — per-operation tool builder
- `buildInputSchema()` — JSON Schema for tool arguments

### Modifying config

Config shape is defined in `src/lib/config.js`:
- `loadConfig()` — merges file config, env vars, and overrides
- `saveConfig()` — persists to `~/.xco/config.json` (never writes plaintext passwords)

## Code Style

- Pure ESM (`"type": "module"`)
- Zero runtime dependencies
- Node.js >=22 built-in APIs only (`node:fs`, `node:http`, `node:crypto`, etc.)
- Comments only where behavior is non-obvious
- Errors include context (file paths, operation names) for debuggability

## Important Patterns

- **Credential safety**: `saveConfig()` strips plaintext passwords before writing. Only env var names are persisted.
- **Readonly mode**: `config.readonly = true` filters generated tools to read-only operations and blocks write raw requests.
- **Tunnel lifecycle**: Tunnels are opened on first API call and reused. `closeTunnels()` cleans up all tunnels, session cache, and instance tracking.
- **Session refresh**: Auth tokens are automatically refreshed using the cached refresh token when the access token expires.

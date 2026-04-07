# xco-mcp-server

Unofficial multi-entry MCP/CLI/HTTP server for ExtremeCloud Orchestrator OpenAPI bundles.

## Project Status

This is a personal open-source interoperability project. It is not an official Extreme Networks project, is not published by Extreme Networks, and is not endorsed by Extreme Networks.

It supports:

- `MCP stdio` for agents that allow MCP servers (protocol version `2024-11-05`)
- `MCP Streamable HTTP` for remote agents over HTTP (`POST /mcp`, protocol version `2025-03-26`)
- `CLI` for skills or locked-down agent environments
- `HTTP + SSE` for local automation and streaming progress
- `Docker / Kubernetes` deployment via the included Dockerfile
- `multi-version setup` by downloading official XCO API references and extracting embedded OpenAPI specs
- `username/password auth` with cached access-token and refresh-token handling
- `bastion and multi-hop SSH` access for restricted XCO deployments
- `opt-in bastion password auth` when key-based SSH is unavailable
- `per-hop bastion passwords` for multi-jump chains where each hop has a different password
- `TLS certificate bypass` for corporate instances with self-signed certificates
- `readonly mode` that only exposes read operations
- `patch-version mapping` so official `x.y.z` releases reuse the corresponding `x.y.0` API docs
- `spec source selection` so setup can use official docs, instance docs, or auto fallback

## What It Does

The server loads XCO service OpenAPI documents and turns each operation into a callable tool. It keeps one active XCO version at a time, but it can cache multiple downloaded versions locally and switch between them.

The repository ships only a synthetic local test fixture in [specs/tenant-service-fixture.json](specs/tenant-service-fixture.json). Official XCO specs are downloaded into `.xco/` during setup and are not redistributed by the repository.

Nothing under `docs/` is copied from Extreme Networks. Those files are project-authored notes, usage guidance, and links back to the official sites.

## Install

```bash
npm install
```

Node `>=22` is required.

If you are bringing up a brand-new MCP instance from zero, start with [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Setup A Version

Download and activate a version from the official docs:

```bash
node ./src/cli.js setup --version 3.7.0 --base-url https://xco.company.example
```

Use instance docs instead of the official site:

```bash
node ./src/cli.js setup \
  --version 3.7.0 \
  --base-url https://xco.company.example \
  --spec-source instance \
  --docs-url https://xco.company.example/docs/
```

Use auto mode to try the instance first and fall back to the official docs:

```bash
node ./src/cli.js setup \
  --version 3.7.1 \
  --base-url https://xco.company.example \
  --spec-source auto
```

This stores downloaded specs under `.xco/versions/<version>/`.

For official docs, patch releases automatically map to the corresponding `x.y.0` docs set. For example, `3.7.1` uses `3.7.0` docs and `3.8.7` uses `3.8.0` docs.

For the first end-to-end bootstrap on a new MCP instance, including auth, bastion, readonly, and launch steps, use [docs/QUICKSTART.md](docs/QUICKSTART.md).

Switch to an already downloaded version:

```bash
node ./src/cli.js use-version --version 4.0.0
```

List installed versions:

```bash
node ./src/cli.js versions
```

Discover remote versions from the docs site:

```bash
node ./src/cli.js versions --remote
```

Detailed runtime guidance is collected in the documentation links near the end of this README.

## CLI Usage

Describe the active bundle:

```bash
node ./src/cli.js describe
```

List generated tools:

```bash
node ./src/cli.js tools
```

Call one generated tool:

```bash
node ./src/cli.js call tenant__gettenants --json '{}'
```

Send a raw request:

```bash
node ./src/cli.js raw --method GET --service-prefix /v1/tenant --path /tenants
```

Auth commands:

```bash
node ./src/cli.js auth status
node ./src/cli.js auth login --username admin --password 'secret'
node ./src/cli.js auth logout
```

## MCP Usage

### Stdio transport

Start the stdio MCP server:

```bash
node ./src/server.js
```

This is the classic local transport. The agent host launches the process and communicates via `stdin`/`stdout` with Content-Length framed JSON-RPC (protocol version `2024-11-05`).

### Streamable HTTP transport

The HTTP server exposes a standards-compliant MCP Streamable HTTP endpoint at `/mcp` (protocol version `2025-03-26`). This enables remote MCP access over HTTP.

```bash
node ./src/http-server.js
# MCP endpoint: http://127.0.0.1:8787/mcp
```

Supported methods on `/mcp`:

- `POST` — JSON-RPC requests, notifications, and batches
- `DELETE` — session termination
- `GET` — SSE stream (returns 405; no server-initiated messages currently)
- `OPTIONS` — CORS preflight

Session flow:

1. Client sends `POST /mcp` with `initialize` request → receives `Mcp-Session-Id` header
2. Client sends `POST /mcp` with `initialized` notification (include `Mcp-Session-Id`)
3. Subsequent requests include `Mcp-Session-Id` header
4. Client sends `DELETE /mcp` with `Mcp-Session-Id` to terminate the session

Default meta tools:

- `xco_setup_version`
- `xco_use_version`
- `xco_list_versions`
- `xco_describe_bundle`
- `xco_auth_login`
- `xco_auth_status`
- `xco_auth_logout`
- `xco_raw_request`

Generated tools use the naming pattern:

```text
<service_slug>__<operation_id>
```

Example:

```text
tenant__gettenants
```

## HTTP + SSE Usage

Start the HTTP server:

```bash
node ./src/http-server.js
```

By default it listens on `http://127.0.0.1:8787`.

The server exposes both the MCP Streamable HTTP transport at `/mcp` (see above) and the following REST API:

Endpoints:

- `GET /healthz`
- `GET /v1/tools`
- `GET /v1/bundle`
- `GET /v1/versions?remote=1`
- `GET /v1/auth/status`
- `GET /v1/events`
- `POST /v1/setup`
- `POST /v1/use-version`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `POST /v1/call`
- `POST /v1/raw`

Example:

```bash
curl http://127.0.0.1:8787/v1/tools
curl -X POST http://127.0.0.1:8787/v1/setup -H 'content-type: application/json' -d '{"version":"3.7.0"}'
```

SSE clients can subscribe to `/v1/events` to receive progress events for setup and request execution.

## Docker

Build the image:

```bash
docker build -t xco-mcp-server .
```

Run the HTTP server (serves REST API + MCP Streamable HTTP on `/mcp`):

```bash
docker run -d -p 8787:8787 \
  -e XCO_PASSWORD=your-password \
  xco-mcp-server
```

Run in MCP stdio mode:

```bash
docker run --rm -i \
  -e XCO_PASSWORD=your-password \
  xco-mcp-server src/server.js
```

Typical MCP client wiring for Docker:

```json
{
  "command": "docker",
  "args": ["run", "--rm", "-i", "xco-mcp-server", "src/server.js"],
  "env": {
    "XCO_PASSWORD": "your-xco-password"
  }
}
```

For Kubernetes deployment, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Runtime Configuration

Environment variables:

- `XCO_BASE_URL`
- `XCO_TOKEN`
- `XCO_TOKEN_ENV`
- `XCO_USERNAME`
- `XCO_USERNAME_ENV`
- `XCO_PASSWORD`
- `XCO_PASSWORD_ENV`
- `XCO_VERSION`
- `XCO_SPEC_SOURCE`
- `XCO_DOCS_URL`
- `XCO_HOME`
- `XCO_CONFIG`
- `XCO_SESSION_PATH`
- `XCO_SPECS_DIR`
- `XCO_READONLY`
- `XCO_BASTION_JUMPS`
- `XCO_BASTION_IDENTITY_FILE`
- `XCO_BASTION_PASSWORD`
- `XCO_BASTION_PASSWORD_ENV`
- `XCO_BASTION_PASSWORD_AUTH`
- `XCO_BASTION_PASSWORDS` — comma-separated per-hop passwords (one per jump host, in order)
- `XCO_BASTION_PASSWORDS_ENV` — comma-separated env var names for per-hop passwords
- `XCO_BASTION_TARGET_HOST`
- `XCO_BASTION_TARGET_PORT`
- `XCO_BASTION_LOCAL_PORT`
- `XCO_BASTION_BIND_HOST`
- `XCO_BASTION_STRICT_HOST_KEY_CHECKING`
- `XCO_TLS_REJECT_UNAUTHORIZED` — set to `0` to skip TLS certificate validation (for self-signed certs)
- `XCO_HTTP_HOST`
- `XCO_HTTP_PORT`

The runtime joins your configured `XCO_BASE_URL` with the per-service base path from the OpenAPI server entry. For example, a service server path of `/v1/tenant` becomes:

```text
https://xco.company.example/v1/tenant/...
```

## Mock E2E

The repository includes an end-to-end script for the bastion, auth, instance-docs, generated-tool, and readonly paths:

```bash
./scripts/e2e-auth-mock.sh
```

The script applies [examples/mock-xco-k8s.yaml](examples/mock-xco-k8s.yaml), restarts the mock deployment, resolves the running pod's node IP, and tests through the mock `NodePort` service. It uses `NodePort` instead of `ClusterIP` because some bastion/control-plane environments can reach the Kubernetes API service VIP but not arbitrary workload `ClusterIP` addresses.

Minimum environment:

```bash
export KUBECONFIG=/path/to/kubeconfig
export XCO_E2E_BASTION_JUMPS='ops@jump1,ops@jump2'
export XCO_BASTION_PASSWORD='your-bastion-password'
export XCO_PASSWORD='secret'
./scripts/e2e-auth-mock.sh
```

Defaults:

- mock XCO login user: `admin`
- mock XCO login password env: `XCO_PASSWORD`
- bastion password env: `XCO_BASTION_PASSWORD`
- mock XCO version: `3.7.0`
- mock base URL: `http://mock-xco.local:8080`

If you want the script to find alternate local binaries first during development, prepend a directory to `PATH`:

```bash
export XCO_E2E_PATH_PREFIX=/tmp
./scripts/e2e-auth-mock.sh
```

If your bastion final hop cannot reliably reach services on its own node, pin the mock deployment to a different worker:

```bash
export XCO_E2E_NODE_NAME=raspberrypi5-worker04
./scripts/e2e-auth-mock.sh
```

The script leaves JSON artifacts and recent mock logs in a temp directory and prints that path at the end.

## More Documentation

- [Quickstart](docs/QUICKSTART.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Authentication Guide](docs/AUTH.md)
- [Legal Notes](docs/LEGAL.md)

## Verification

Run:

```bash
npm test
```

## Official Docs Used

The implementation is based on the official Extreme Networks support and API reference pages:

- https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-3-7-0/
- https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-4-0-0/
- https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/tenant.html

The support pages enumerate per-version service API references. The API reference pages embed the OpenAPI spec in the page's `__redoc_state`, which this project extracts during setup.

Legal and trademark references used for the open-source packaging:

- https://www.extremenetworks.com/about-extreme-networks/company/legal/trademarks
- https://www.extremenetworks.com/support/documentation.asp

# Quickstart

This guide is the linear bootstrap flow for bringing up a new `xco-mcp-server` instance.

The commands below are written with environment variables so you can use the same flow for:

- a real XCO deployment
- a bastion-restricted XCO deployment
- the repository's local mock validation flow

Validated locally:

- `npm install`
- `setup` in `official` mode
- `use-version` with multi-hop bastion config
- `auth login`
- `auth status`
- `describe`
- one safe generated read call
- `node ./src/server.js`
- `node ./src/http-server.js` plus `/healthz`

## 1. Choose Your Working Variables

Start in the repository root and export the values you want this MCP instance to use.

```bash
export XCO_HOME="$PWD/.xco"
export XCO_VERSION="3.7.0"
export XCO_BASE_URL="https://xco.company.example"
export XCO_USERNAME="admin"
export XCO_PASSWORD="your-xco-password"

# Only if you must go through one or more SSH jump hosts:
export XCO_BASTION_JUMPS="ops@jump1,ops@jump2"
export XCO_BASTION_PASSWORD="your-bastion-password"
export XCO_BASTION_TARGET_HOST="10.20.30.40"
export XCO_BASTION_TARGET_PORT="443"
```

Notes:

- `XCO_HOME` is where this instance stores `.xco/config.json`, downloaded specs, and `.xco/session.json`
- `XCO_PASSWORD` and `XCO_BASTION_PASSWORD` are runtime secrets and should come from your shell, secret store, or MCP client env injection
- if you have direct access to XCO, omit the bastion variables
- if you use SSH keys, keep `XCO_BASTION_JUMPS` and replace the password flags in step 4 with `--bastion-identity-file ~/.ssh/id_ed25519`

## 2. Install Dependencies

```bash
npm install
```

Node `>=22` is required.

## 3. Download The XCO Bundle

Recommended first-run command:

```bash
node ./src/cli.js setup \
  --version "$XCO_VERSION" \
  --base-url "$XCO_BASE_URL"
```

Why this is the default:

- it downloads specs from the official Extreme docs site
- it does not need your XCO instance `/docs` page to be reachable
- it still saves `baseUrl` into the local config for later API calls

If your XCO instance exposes `/docs/` and you want to use the live instance docs instead:

- replace the default command with `--spec-source instance` or `--spec-source auto`
- if `/docs/` is only reachable through the same bastion path as the API, add the same `--bastion-*` flags shown in step 4
- if your `/docs/` page is protected and not easily reachable, keep using the default `official` setup flow

## 4. Persist Runtime Connection Settings

```bash
node ./src/cli.js use-version \
  --version "$XCO_VERSION" \
  --base-url "$XCO_BASE_URL" \
  --username-env XCO_USERNAME \
  --password-env XCO_PASSWORD \
  --bastion-jumps "$XCO_BASTION_JUMPS" \
  --bastion-password-auth true \
  --bastion-password-env XCO_BASTION_PASSWORD \
  --bastion-target-host "$XCO_BASTION_TARGET_HOST" \
  --bastion-target-port "$XCO_BASTION_TARGET_PORT"
```

If you have direct access to XCO, omit the `--bastion-*` flags.

Optional readonly mode:

```bash
node ./src/cli.js use-version \
  --version "$XCO_VERSION" \
  --readonly true
```

`config.json` stores connection settings and environment variable names, but it does not store the cleartext password values.

## 5. Create A Cached Login Session

```bash
node ./src/cli.js auth login \
  --base-url "$XCO_BASE_URL" \
  --username-env XCO_USERNAME \
  --password-env XCO_PASSWORD \
  --persist-config true
```

This creates or refreshes the cached session in `"$XCO_HOME/session.json"`.

## 6. Verify The Instance Before Starting MCP

Check auth state:

```bash
node ./src/cli.js auth status
```

Check the active bundle and loaded services:

```bash
node ./src/cli.js describe
```

Run one safe generated read call:

```bash
node ./src/cli.js call tenant_service__gethealth --json '{}'
```

If your chosen version does not expose `tenant_service__gethealth`, run `node ./src/cli.js tools` and pick any safe `GET` operation from the generated list.

## 7. Start The MCP Server

```bash
node ./src/server.js
```

This is the process your coding agent should launch as the MCP server.

Typical MCP client wiring looks like this:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/xco-mcp-server/src/server.js"],
  "cwd": "/absolute/path/to/xco-mcp-server",
  "env": {
    "XCO_HOME": "/absolute/path/to/xco-home",
    "XCO_PASSWORD": "your-xco-password",
    "XCO_BASTION_PASSWORD": "your-bastion-password"
  }
}
```

The exact JSON shape depends on the MCP client, but the important part is:

- `command` points to `node`
- `args` points to `src/server.js`
- `cwd` points to the repo root
- `env` injects runtime secrets that are not written into `config.json`

## 8. Optional: MCP Over HTTP (Streamable HTTP)

If your agent needs remote MCP access rather than local stdio, use the HTTP server which exposes both the REST API and MCP Streamable HTTP on `/mcp`:

```bash
node ./src/http-server.js
# MCP endpoint: http://127.0.0.1:8787/mcp
```

The `/mcp` endpoint implements MCP protocol version `2025-03-26`. Session flow:

1. `POST /mcp` with `initialize` → get `Mcp-Session-Id` header
2. `POST /mcp` with `initialized` notification
3. Subsequent `POST /mcp` calls include `Mcp-Session-Id`
4. `DELETE /mcp` to terminate

## 9. Optional: Docker

Build and run as a container:

```bash
docker build -t xco-mcp-server .
docker run -d -p 8787:8787 -e XCO_PASSWORD=your-password xco-mcp-server
```

For stdio MCP via Docker:

```json
{
  "command": "docker",
  "args": ["run", "--rm", "-i", "xco-mcp-server", "src/server.js"],
  "env": {
    "XCO_PASSWORD": "your-xco-password"
  }
}
```

## 10. Optional: REST API Fallback

If your agent environment blocks MCP servers but allows local HTTP:

```bash
node ./src/http-server.js
```

Basic check:

```bash
curl http://127.0.0.1:8787/healthz
```

Useful endpoints:

- `GET /healthz`
- `GET /v1/tools`
- `GET /v1/bundle`
- `GET /v1/auth/status`
- `POST /v1/setup`
- `POST /v1/use-version`
- `POST /v1/auth/login`
- `POST /v1/call`
- `POST /v1/raw`

## 11. What Gets Stored Where

`$XCO_HOME/config.json`

- active version
- base URL
- docs source mode
- readonly flag
- bastion settings
- `usernameEnv`, `passwordEnv`, `tokenEnv`, `bastionPasswordEnv`

`$XCO_HOME/session.json`

- cached access token
- cached refresh token
- token expiry metadata

Not written to `config.json`:

- cleartext XCO password
- cleartext bastion password
- cleartext bearer token value

## 12. Recommended Defaults

For a brand-new MCP instance:

1. Use `official` setup first unless you know your XCO `/docs/` page is reachable.
2. Persist `username-env` and `password-env` instead of hardcoding passwords in commands.
3. If you need a bastion, persist the jump topology and the password env var name, not the password.
4. Run `auth login` once before starting the MCP server so the first tool call does not have to do the initial login.
5. Start with `readonly` if your first goal is inspection rather than changes.

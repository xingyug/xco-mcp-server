# Authentication

`xco-mcp-server` supports two authentication modes:

1. Static bearer token
2. Username/password login through the XCO Auth Service, with cached access and refresh tokens

## Static Token

Use this when your environment already issues a bearer token:

```bash
export XCO_BASE_URL=https://xco.company.example
export XCO_TOKEN=your-token
node ./dist/src/server.js
```

Or persist the token environment variable name in local config:

```bash
node ./dist/src/cli.js use-version --version 3.7.0 --token-env XCO_TOKEN
```

## Username And Password

The runtime can authenticate against the XCO Auth Service and cache the resulting access and refresh tokens locally.

Recommended pattern:

```bash
export XCO_USERNAME=admin
export XCO_PASSWORD='secret'
node ./dist/src/cli.js auth login --base-url https://xco.company.example --username-env XCO_USERNAME --password-env XCO_PASSWORD --persist-config true
```

Direct credentials also work for a one-off login:

```bash
node ./dist/src/cli.js auth login --base-url https://xco.company.example --username admin --password 'secret'
```

The runtime stores cached sessions in `.xco/session.json` by default. Session keys are scoped by:

- active XCO version
- logical `baseUrl`
- username

## Auto Refresh

For operations that require bearer auth, the runtime does the following:

1. Use `XCO_TOKEN` or `XCO_TOKEN_ENV` if one is configured.
2. Otherwise load a cached session for the active version, base URL, and username.
3. Reuse the access token if it is still valid.
4. Try the refresh token when the access token is expired.
5. Fall back to username/password login when no usable session exists.
6. Retry once on HTTP `401` after a forced token renewal.

## CLI Commands

```bash
node ./dist/src/cli.js auth status
node ./dist/src/cli.js auth login --username admin --password 'secret'
node ./dist/src/cli.js auth logout
```

## HTTP Endpoints

```text
GET  /v1/auth/status
POST /v1/auth/login
POST /v1/auth/logout
```

Example:

```bash
curl -X POST http://127.0.0.1:8787/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"baseUrl":"https://xco.company.example","username":"admin","password":"secret"}'
```

## Environment Variables

- `XCO_BASE_URL`
- `XCO_TOKEN`
- `XCO_TOKEN_ENV`
- `XCO_USERNAME`
- `XCO_USERNAME_ENV`
- `XCO_PASSWORD`
- `XCO_PASSWORD_ENV`
- `XCO_SESSION_PATH`

## Notes

- The server never persists a cleartext password to `config.json`.
- `--persist-config true` stores `baseUrl`, `username`, `usernameEnv`, and `passwordEnv`, but not the password value.
- If you use bastion tunneling, the auth requests go through the same tunnel as the target API calls.

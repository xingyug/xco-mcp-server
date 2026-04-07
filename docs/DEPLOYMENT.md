# Deployment

## Runtime Modes

This project exposes the same XCO capability set through three local entry points:

1. `MCP stdio` for agent runtimes that support MCP servers
2. `CLI` for skills or locked-down agent environments
3. `HTTP + SSE` for local automation, progress streaming, and wrappers

All three entry points share the same local config, cached bundles, auth session store, and HTTP execution layer.

## Install

```bash
npm install
```

Node `>=22` is required.

## Version Setup

Download and activate an XCO version from the official documentation site:

```bash
node ./src/cli.js setup --version 3.7.0 --base-url https://xco.company.example
```

If your instance exposes its own `/docs` page or a direct Redoc/OpenAPI endpoint, you can use that instead:

```bash
node ./src/cli.js setup \
  --version 3.7.0 \
  --base-url https://xco.company.example \
  --spec-source instance \
  --docs-url https://xco.company.example/docs/
```

Auto mode tries instance docs first and then falls back to the official docs:

```bash
node ./src/cli.js setup \
  --version 3.7.1 \
  --base-url https://xco.company.example \
  --spec-source auto
```

Switch to an already cached version:

```bash
node ./src/cli.js use-version --version 4.0.0
```

Discover published versions from the official support index:

```bash
node ./src/cli.js versions --remote
```

For official docs, patch releases do not fetch their own support pages anymore. The downloader maps `x.y.z` patch releases to the corresponding `x.y.0` docs set, for example `3.2.1 -> 3.2.0` and `3.8.7 -> 3.8.0`.

## Readonly Deployments

Readonly mode hides generated write operations and blocks non-read raw requests.

Persist readonly mode into local config:

```bash
node ./src/cli.js use-version --version 3.7.0 --readonly true
```

Or set it through the environment:

```bash
export XCO_READONLY=true
node ./src/server.js
```

Readonly mode still keeps the operational meta tools available, including:

- version setup and switching
- auth status, login, and logout
- raw requests, but only with `GET`, `HEAD`, or `OPTIONS`

## Bastion And Multi-Hop SSH

If your XCO instance is reachable only through one or more jump hosts, the runtime can open a local SSH tunnel automatically.

Single bastion example:

```bash
node ./src/cli.js use-version \
  --version 3.7.0 \
  --base-url https://xco.company.example \
  --bastion-jumps ops@bastion1 \
  --bastion-target-host 10.20.30.40
```

Multi-hop example:

```bash
node ./src/cli.js use-version \
  --version 3.7.0 \
  --base-url https://xco.company.example \
  --bastion-jumps ops@jump1,ops@jump2 \
  --bastion-target-host 10.20.30.40 \
  --bastion-identity-file ~/.ssh/id_ed25519 \
  --bastion-local-port 9443
```

Relevant settings:

- `bastionJumps`
- `bastionIdentityFile`
- `bastionPasswordAuth`
- `bastionPasswordEnv`
- `bastionTargetHost`
- `bastionTargetPort`
- `bastionLocalPort`
- `bastionBindHost`
- `bastionStrictHostKeyChecking`

Behavior:

- the last hop in `bastionJumps` becomes the SSH session target
- earlier hops are passed through `ssh -J`
- the tunnel forwards a local port to the XCO host and port derived from `baseUrl` or the explicit `bastionTargetHost` and `bastionTargetPort`
- relative or `~/...` identity file paths are resolved locally before launching `ssh`

### Bastion Password Auth

Key-based SSH remains the recommended mode. If your bastion only allows username + password, the runtime can use a non-interactive `SSH_ASKPASS` helper, but only when you explicitly opt in.

Requirements:

- `bastionPasswordAuth=true`
- either `bastionPasswordEnv` set to an environment variable name, or a one-time `bastionPassword` parameter

Recommended pattern:

```bash
export XCO_BASTION_PASSWORD='secret'
node ./src/cli.js use-version \
  --version 3.7.0 \
  --bastion-jumps ops@jump1,ops@jump2 \
  --bastion-password-auth true \
  --bastion-password-env XCO_BASTION_PASSWORD \
  --bastion-target-host 10.20.30.40
```

### Per-Hop Bastion Passwords

When each jump host in a multi-hop chain requires a different password, you can supply one password per hop:

```bash
export HOP1_PASS='password-for-jump1'
export HOP2_PASS='password-for-jump2'
node ./src/cli.js use-version \
  --version 3.7.0 \
  --bastion-jumps ops@jump1,ops@jump2 \
  --bastion-password-auth true \
  --bastion-passwords-env HOP1_PASS,HOP2_PASS \
  --bastion-target-host 10.20.30.40
```

Or via environment variables:

```bash
export XCO_BASTION_JUMPS='ops@jump1,ops@jump2'
export XCO_BASTION_PASSWORDS_ENV='HOP1_PASS,HOP2_PASS'
export XCO_BASTION_PASSWORD_AUTH=true
```

Rules:

- provide exactly 1 shared password **or** exactly N passwords for N jumps
- mismatched counts are rejected at startup
- the askpass helper matches the SSH prompt `user@host's password:` against configured jump entries
- if no match is found, the prompt fails rather than sending a wrong password
- plaintext passwords are never persisted; only env var names are saved to `config.json`

Notes:

- plaintext bastion passwords are never written to `config.json`
- only the environment variable name can be persisted
- one-time `bastionPassword` values are useful for a single `setup` or `raw` command, but not for long-lived persisted workflows
- MFA, OTP, and interactive keyboard-auth prompts are still outside the supported path

### TLS Certificate Validation

Corporate XCO instances often use self-signed or internal CA certificates. To skip TLS certificate validation:

```bash
export XCO_TLS_REJECT_UNAUTHORIZED=0
```

Or pass it via CLI:

```bash
node ./src/cli.js call tenant__gettenants --tls-reject-unauthorized 0
```

This sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for all HTTPS requests made by the runtime. **Use only in trusted networks** — disabling TLS validation removes protection against man-in-the-middle attacks.

## MCP

```bash
node ./src/server.js
```

Useful meta tools:

- `xco_setup_version`
- `xco_use_version`
- `xco_list_versions`
- `xco_describe_bundle`
- `xco_auth_login`
- `xco_auth_status`
- `xco_auth_logout`
- `xco_raw_request`

## CLI

```bash
node ./src/cli.js describe
node ./src/cli.js tools
node ./src/cli.js call tenant_service__gettenants --json '{}'
node ./src/cli.js raw --method GET --service-prefix /v1/tenant --path /tenants
```

## HTTP + SSE

```bash
node ./src/http-server.js
```

Default listen address:

```text
http://127.0.0.1:8787
```

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

SSE subscribers can attach to `/v1/events` to receive progress events for setup, auth, SSH tunnel creation, and tool execution.

## Skills / Wrapper Integration

For environments that block MCP servers, prefer wrapping the CLI:

```bash
node ./src/cli.js call xco_describe_bundle --json '{}'
```

If local HTTP is allowed, wrappers can call the HTTP server and consume SSE progress:

```bash
curl http://127.0.0.1:8787/v1/tools
curl http://127.0.0.1:8787/v1/events
```

## Mock Auth E2E

The repository includes [scripts/e2e-auth-mock.sh](../scripts/e2e-auth-mock.sh), which runs a full bastion and auth regression against the synthetic mock deployment in [examples/mock-xco-k8s.yaml](../examples/mock-xco-k8s.yaml).

It verifies:

- `specSource=instance` setup from `/docs/`
- multi-hop bastion tunneling
- opt-in bastion password auth
- `xco_auth_login`
- automatic refresh-token use on protected generated tools
- generated `auth__*` and `tenant__*` tool calls (service slugs depend on the mock's `/docs` page)
- readonly mode hiding write tools and blocking write requests

Minimum environment:

```bash
export KUBECONFIG=/path/to/kubeconfig
export XCO_E2E_BASTION_JUMPS='ops@jump1,ops@jump2'
export XCO_BASTION_PASSWORD='your-bastion-password'
export XCO_PASSWORD='secret'
./scripts/e2e-auth-mock.sh
```

Useful overrides:

- `XCO_E2E_MANIFEST` to point at a different mock manifest
- `XCO_E2E_VERSION` to change the version label passed to setup
- `XCO_E2E_BASE_URL` to change the logical instance URL
- `XCO_E2E_USERNAME` to change the mock login user
- `XCO_E2E_PASSWORD_ENV` to rename the XCO login password env var
- `XCO_E2E_BASTION_PASSWORD_ENV` to rename the bastion password env var
- `XCO_E2E_PATH_PREFIX` to prepend a directory containing alternate local binaries used by the script
- `XCO_E2E_XCO_HOME` to keep the generated config and session store in a fixed location
- `XCO_E2E_VERIFY_READONLY=false` to skip the readonly subtest
- `XCO_E2E_NODE_NAME` to pin the mock deployment to a specific Kubernetes node before the rollout restart

The script intentionally targets the running mock pod's node IP plus the `mock-xco-nodeport` service. That avoids depending on workload `ClusterIP` reachability from the bastion/control-plane path, which is not guaranteed in every cluster.

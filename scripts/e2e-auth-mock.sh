#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[e2e] %s\n' "$*"
}

fail() {
  printf '[e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

require_named_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "Missing required environment variable: $name"
  fi
}

json_query() {
  local file_path="$1"
  local expression="$2"
  node --input-type=module -e '
    import fs from "node:fs";

    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const evaluate = new Function("data", process.argv[2]);
    const value = evaluate(data);

    if (typeof value === "string") {
      process.stdout.write(value);
    } else {
      process.stdout.write(JSON.stringify(value));
    }
  ' "$file_path" "$expression"
}

run_json_command() {
  local output_file="$1"
  shift

  "$@" >"$output_file"
  cat "$output_file"
  printf '\n'
}

run_expect_failure() {
  local output_file="$1"
  shift

  if "$@" >"$output_file" 2>&1; then
    fail "Expected command to fail, but it succeeded: $*"
  fi

  cat "$output_file"
  printf '\n'
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

MANIFEST_PATH="${XCO_E2E_MANIFEST:-$REPO_DIR/examples/mock-xco-k8s.yaml}"
NAMESPACE="${XCO_E2E_NAMESPACE:-xco-e2e}"
DEPLOYMENT_NAME="${XCO_E2E_DEPLOYMENT:-mock-xco}"
APP_SELECTOR="${XCO_E2E_APP_SELECTOR:-app=mock-xco}"
NODEPORT_SERVICE="${XCO_E2E_NODEPORT_SERVICE:-mock-xco-nodeport}"
VERSION="${XCO_E2E_VERSION:-3.7.0}"
BASE_URL="${XCO_E2E_BASE_URL:-http://mock-xco.local:8080}"
USERNAME="${XCO_E2E_USERNAME:-admin}"
LOGIN_PASSWORD_ENV_NAME="${XCO_E2E_PASSWORD_ENV:-XCO_PASSWORD}"
BASTION_PASSWORD_ENV_NAME="${XCO_E2E_BASTION_PASSWORD_ENV:-XCO_BASTION_PASSWORD}"
PATH_PREFIX="${XCO_E2E_PATH_PREFIX:-}"
BastionJumps="${XCO_E2E_BASTION_JUMPS:-}"
VERIFY_READONLY="${XCO_E2E_VERIFY_READONLY:-true}"
PINNED_NODE_NAME="${XCO_E2E_NODE_NAME:-}"

if [[ -n "$PATH_PREFIX" ]]; then
  export PATH="$PATH_PREFIX:$PATH"
fi

require_command kubectl
require_command node
require_command ssh

if [[ -z "$BastionJumps" ]]; then
  fail "Missing required environment variable: XCO_E2E_BASTION_JUMPS"
fi

require_named_env "$LOGIN_PASSWORD_ENV_NAME"
require_named_env "$BASTION_PASSWORD_ENV_NAME"

WORK_DIR="$(mktemp -d /tmp/xco-auth-mock-e2e-XXXXXX)"
OUTPUT_DIR="$WORK_DIR/output"
XCO_HOME="${XCO_E2E_XCO_HOME:-$WORK_DIR/xco-home}"
mkdir -p "$OUTPUT_DIR" "$XCO_HOME"

BASE_ENV=(
  env
  "XCO_HOME=$XCO_HOME"
  "${BASTION_PASSWORD_ENV_NAME}=${!BASTION_PASSWORD_ENV_NAME}"
)

AUTH_ENV=(
  "${BASE_ENV[@]}"
  "${LOGIN_PASSWORD_ENV_NAME}=${!LOGIN_PASSWORD_ENV_NAME}"
)

resolve_target() {
  RUNNING_POD_NAME="$(
    kubectl -n "$NAMESPACE" get pods -l "$APP_SELECTOR" --field-selector=status.phase=Running \
      --sort-by=.metadata.creationTimestamp -o name | tail -n 1 | sed 's#^pod/##'
  )"
  RUNNING_NODE_NAME="$(
    kubectl -n "$NAMESPACE" get pod "$RUNNING_POD_NAME" -o jsonpath='{.spec.nodeName}'
  )"
  NODE_PORT="$(
    kubectl -n "$NAMESPACE" get svc "$NODEPORT_SERVICE" -o jsonpath='{.spec.ports[0].nodePort}'
  )"
  TARGET_HOST="$(
    kubectl get node "$RUNNING_NODE_NAME" \
      -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}'
  )"

  if [[ -z "$RUNNING_POD_NAME" || -z "$RUNNING_NODE_NAME" || -z "$NODE_PORT" || -z "$TARGET_HOST" ]]; then
    fail "Failed to resolve the running mock pod, node, or NodePort."
  fi

  log "Current bastion target: $RUNNING_POD_NAME on $RUNNING_NODE_NAME ($TARGET_HOST:$NODE_PORT)"
}

persist_target_config() {
  resolve_target
  env "XCO_HOME=$XCO_HOME" node "$REPO_DIR/src/cli.js" use-version \
    --version "$VERSION" \
    --base-url "$BASE_URL" \
    --username "$USERNAME" \
    --bastion-jumps "$BastionJumps" \
    --bastion-password-auth true \
    --bastion-password-env "$BASTION_PASSWORD_ENV_NAME" \
    --bastion-target-host "$TARGET_HOST" \
    --bastion-target-port "$NODE_PORT" >/dev/null
}

log "Working directory: $WORK_DIR"
log "XCO_HOME: $XCO_HOME"
log "Applying mock manifest: $MANIFEST_PATH"
kubectl apply -f "$MANIFEST_PATH" >/dev/null

if [[ -n "$PINNED_NODE_NAME" ]]; then
  log "Pinning deployment/$DEPLOYMENT_NAME to node $PINNED_NODE_NAME"
  kubectl -n "$NAMESPACE" patch "deployment/$DEPLOYMENT_NAME" --type merge \
    -p "{\"spec\":{\"template\":{\"spec\":{\"nodeSelector\":{\"kubernetes.io/hostname\":\"$PINNED_NODE_NAME\"}}}}}" >/dev/null
fi

log "Restarting deployment/$DEPLOYMENT_NAME in namespace $NAMESPACE"
kubectl -n "$NAMESPACE" rollout restart "deployment/$DEPLOYMENT_NAME" >/dev/null
kubectl -n "$NAMESPACE" rollout status "deployment/$DEPLOYMENT_NAME" --timeout=120s >/dev/null

resolve_target

SETUP_JSON="$OUTPUT_DIR/setup.json"
TOOLS_JSON="$OUTPUT_DIR/tools.json"
LOGIN_JSON="$OUTPUT_DIR/auth-login.json"
AUTH_CREATE_JSON="$OUTPUT_DIR/auth-create-tool.json"
AUTH_REFRESH_JSON="$OUTPUT_DIR/auth-refresh-tool.json"
TENANT_HEALTH_JSON="$OUTPUT_DIR/tenant-health.json"
TENANT_LIST_BEFORE_JSON="$OUTPUT_DIR/tenant-list-before.json"
TENANT_CREATE_JSON="$OUTPUT_DIR/tenant-create.json"
TENANT_LIST_AFTER_JSON="$OUTPUT_DIR/tenant-list-after.json"
AUTH_STATUS_JSON="$OUTPUT_DIR/auth-status.json"
READONLY_TOOLS_JSON="$OUTPUT_DIR/readonly-tools.json"
READONLY_HEALTH_JSON="$OUTPUT_DIR/readonly-health.json"
READONLY_BLOCKED_TXT="$OUTPUT_DIR/readonly-blocked.txt"
LOGS_TXT="$OUTPUT_DIR/mock-logs.txt"

log "Running setup against instance /docs through the bastion chain"
run_json_command \
  "$SETUP_JSON" \
  "${AUTH_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" setup \
    --version "$VERSION" \
    --spec-source instance \
    --base-url "$BASE_URL" \
    --username "$USERNAME" \
    --password-env "$LOGIN_PASSWORD_ENV_NAME" \
    --bastion-jumps "$BastionJumps" \
    --bastion-password-auth true \
    --bastion-password-env "$BASTION_PASSWORD_ENV_NAME" \
    --bastion-target-host "$TARGET_HOST" \
    --bastion-target-port "$NODE_PORT"

SERVICES_CSV="$(json_query "$SETUP_JSON" 'return data.manifest.services.map((service) => service.serviceSlug).sort().join(",");')"
if [[ "$SERVICES_CSV" != "auth,tenant" ]]; then
  fail "Expected auth and tenant services, got: $SERVICES_CSV"
fi

persist_target_config

log "Listing generated tools"
run_json_command "$TOOLS_JSON" env "XCO_HOME=$XCO_HOME" node "$REPO_DIR/src/cli.js" tools

for required_tool in \
  auth__createaccesstoken \
  auth__refreshaccesstoken \
  tenant__createtenant \
  tenant__gethealth \
  tenant__gettenants
do
  if ! grep -q "\"name\": \"$required_tool\"" "$TOOLS_JSON"; then
    fail "Missing generated tool: $required_tool"
  fi
done

persist_target_config

log "Running xco_auth_login"
run_json_command \
  "$LOGIN_JSON" \
  "${AUTH_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" auth login

SESSION_FILE="$XCO_HOME/session.json"
if [[ ! -f "$SESSION_FILE" ]]; then
  fail "Session file was not created at $SESSION_FILE"
fi

LOGIN_SESSION_UPDATED_AT="$(json_query "$SESSION_FILE" 'return Object.values(data.sessions)[0].updatedAt;')"
LOGIN_SESSION_REFRESH_TOKEN="$(json_query "$SESSION_FILE" 'return Object.values(data.sessions)[0].refreshToken;')"

log "Calling generated auth__createaccesstoken"
run_json_command \
  "$AUTH_CREATE_JSON" \
  "${BASE_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call auth__createaccesstoken \
    --json "{\"body\":{\"username\":\"$USERNAME\",\"password\":\"${!LOGIN_PASSWORD_ENV_NAME}\"}}"

GENERATED_REFRESH_TOKEN="$(json_query "$AUTH_CREATE_JSON" 'return data.body["refresh-token"];')"
if [[ -z "$GENERATED_REFRESH_TOKEN" ]]; then
  fail "auth__createaccesstoken did not return a refresh token"
fi

log "Calling generated auth__refreshaccesstoken"
run_json_command \
  "$AUTH_REFRESH_JSON" \
  "${BASE_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call auth__refreshaccesstoken \
    --json "{\"body\":{\"grant-type\":\"refresh_token\",\"refresh-token\":\"$GENERATED_REFRESH_TOKEN\"}}"

persist_target_config

log "Calling generated tenant__gethealth"
run_json_command \
  "$TENANT_HEALTH_JSON" \
  "${BASE_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call tenant__gethealth --json '{}'

persist_target_config

log "Calling generated tenant__gettenants before create"
run_json_command \
  "$TENANT_LIST_BEFORE_JSON" \
  "${AUTH_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call tenant__gettenants --json '{}'

REFRESHED_SESSION_UPDATED_AT="$(json_query "$SESSION_FILE" 'return Object.values(data.sessions)[0].updatedAt;')"
REFRESHED_SESSION_REFRESH_TOKEN="$(json_query "$SESSION_FILE" 'return Object.values(data.sessions)[0].refreshToken;')"

if [[ "$REFRESHED_SESSION_UPDATED_AT" == "$LOGIN_SESSION_UPDATED_AT" ]]; then
  fail "Expected tenant__gettenants to refresh the cached session, but updatedAt did not change."
fi

if [[ "$REFRESHED_SESSION_REFRESH_TOKEN" == "$LOGIN_SESSION_REFRESH_TOKEN" ]]; then
  fail "Expected tenant__gettenants to rotate the cached refresh token, but it did not change."
fi

persist_target_config

log "Calling generated tenant__createtenant"
run_json_command \
  "$TENANT_CREATE_JSON" \
  "${AUTH_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call tenant__createtenant \
    --json '{"body":{"name":"Tenant-E2E"}}'

persist_target_config

log "Calling generated tenant__gettenants after create"
run_json_command \
  "$TENANT_LIST_AFTER_JSON" \
  "${AUTH_ENV[@]}" \
  node "$REPO_DIR/src/cli.js" call tenant__gettenants --json '{}'

if ! grep -q '"Tenant-E2E"' "$TENANT_LIST_AFTER_JSON"; then
  fail "Tenant-E2E was not returned after tenant__createtenant"
fi

log "Reading auth status"
run_json_command "$AUTH_STATUS_JSON" env "XCO_HOME=$XCO_HOME" node "$REPO_DIR/src/cli.js" auth status

if [[ "$VERIFY_READONLY" == "true" ]]; then
  log "Enabling readonly mode"
  env "XCO_HOME=$XCO_HOME" node "$REPO_DIR/src/cli.js" use-version --version "$VERSION" --readonly true >/dev/null

  log "Verifying readonly tool list"
  run_json_command "$READONLY_TOOLS_JSON" env "XCO_HOME=$XCO_HOME" node "$REPO_DIR/src/cli.js" tools

  if grep -q '"name": "tenant__createtenant"' "$READONLY_TOOLS_JSON"; then
    fail "tenant__createtenant should not be exposed in readonly mode"
  fi

  persist_target_config

  log "Verifying readonly GET still works"
  run_json_command \
    "$READONLY_HEALTH_JSON" \
    "${BASE_ENV[@]}" \
    node "$REPO_DIR/src/cli.js" call tenant__gethealth --json '{}'

  persist_target_config

  log "Verifying readonly blocks write requests"
  run_expect_failure \
    "$READONLY_BLOCKED_TXT" \
    "${AUTH_ENV[@]}" \
    node "$REPO_DIR/src/cli.js" raw \
      --method POST \
      --service-prefix /v1/tenant \
      --path /tenants \
      --body '{"name":"Blocked-By-Readonly"}'

  if ! grep -q 'Readonly mode is enabled' "$READONLY_BLOCKED_TXT"; then
    fail "Readonly verification did not produce the expected error message"
  fi
fi

log "Collecting recent mock logs"
kubectl -n "$NAMESPACE" logs -l "$APP_SELECTOR" --since=5m --prefix >"$LOGS_TXT"
cat "$LOGS_TXT"
printf '\n'

for required_request in \
  '[request] POST /v1/auth/token/access-token' \
  '[request] POST /v1/auth/token/refresh' \
  '[request] GET /v1/tenant/health' \
  '[request] GET /v1/tenant/tenants' \
  '[request] POST /v1/tenant/tenants'
do
  if ! grep -Fq "$required_request" "$LOGS_TXT"; then
    fail "Mock logs are missing expected request: $required_request"
  fi
done

log "PASS"
log "Artifacts: $OUTPUT_DIR"

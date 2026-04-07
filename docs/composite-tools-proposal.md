# Composite (Preset Workflow) Tools — Development Proposal

## 1. Background

### 1.1 Current Architecture

The xco-mcp-server currently exposes two categories of tools:

- **Meta tools** (8): Hard-coded management operations — `xco_setup_version`, `xco_use_version`, `xco_list_versions`, `xco_describe_bundle`, `xco_auth_login`, `xco_auth_status`, `xco_auth_logout`, `xco_raw_request`.
- **Generated tools** (~100–300 per version): Automatically parsed from XCO OpenAPI specs. Each maps 1:1 to a single REST endpoint, e.g. `tenant__createtenant` → `POST /tenants`.

When an agent calls `callTool(name)`, the runtime routes to `callMetaTool()` or `callGeneratedTool()` based on whether the name is in `META_TOOL_NAMES`.

### 1.2 Problem

The 1:1 generated tools are correct but **low-level**. Real XCO operations are multi-step workflows — for example, onboarding a fabric requires creating the fabric, registering devices, adding devices to the fabric, validating topology, configuring the fabric, and checking health. Expecting an LLM agent to discover and correctly sequence 5–8 generated tools across multiple services (fabric, inventory, tenant) is:

- **Fragile** — wrong ordering causes hard-to-diagnose failures
- **Slow** — each step requires a separate tool call round-trip
- **Risky** — no built-in validation, rollback, or confirmation gates

### 1.3 Proposal

Add a third tool category: **Composite workflow tools** (prefix `xco_workflow_*`). These are curated, multi-step operations that internally call generated tools in the correct sequence, with validation, error handling, and optional confirmation gates. They complement (not replace) the generated tools.

---

## 2. Research Findings

### 2.1 XCO Product Functional Areas (from manuals)

| Area | XCO CLI Admin Guide Section | XCO API Services | Key Workflows |
|------|-----------------------------|------------------|---------------|
| **Fabric Lifecycle** | "Fabric Infrastructure Provisioning" (p.122–191) | Fabric Service | Create → Add devices → Validate → Configure → Health |
| **Tenant Provisioning** | "Tenant Service Provisioning" (p.192–507) | Tenant Service | Create tenant → Port channels → VRFs → EPGs → BGP peers |
| **Policy** | "Policy Service Provisioning" (p.508–580) | Policy Service | IP prefix lists → Route maps → Device binding |
| **Device Management** | "XCO Device Management" (p.581–657) | Inventory Service | Register → Firmware download/upgrade → Config backup/replay → Health |
| **Health & Fault** | "Unified Health and Fault Management" (p.691–869) | Monitor + Fault Manager | Health inventory → Alerts → Alarms → Acknowledge/Close |
| **System Admin** | "XCO System Management" (p.27–121) | Monitor + System | Backup → Restore → Certificate management → DRC |
| **Event Management** | "XCO Event Management" (p.658–690) | Notification + SNMP | SNMP proxy → Syslog → Event forwarding |
| **Licensing** | "XCO License Service Management" (p.870–888) | License Service | Install → Status → Capacity |
| **ONE OS Integration** | "ONE OS Integration" (p.889–947) | Inventory (extended) | gRPC certs → Device adapter → Firmware |

### 2.2 Common Multi-Step Workflows (from manuals)

Based on the XCO 4.0.0 CLI Administration Guide and GUI Administration Guide, the following workflows are documented as standard operator procedures:

#### Day-0: Fabric Onboarding
```
1. Register switches in inventory (efa inventory device register)
2. Verify device interfaces (efa inventory device interface list)
3. Create fabric (efa fabric create --name X --type clos/non-clos)
4. Add devices to fabric (efa fabric device add-bulk --leaf ... --spine ...)
5. Topology auto-validates during add
6. Configure fabric (efa fabric configure --name X)
7. Verify health (efa fabric show --name X --health)
```
Source: CLI Admin Guide p.125–142

#### Day-0: Tenant Bootstrap
```
1. Create tenant entity (efa tenant create --name X --vlan-range ... --l2-vni-range ...)
2. Create port channels (efa tenant portchannel create ...)
3. Create VRFs (efa tenant vrf create --name X --tenant T --rt-type ...)
4. Create endpoint groups (efa tenant epg create --name X --tenant T --vrf V ...)
5. Configure endpoint group networks (efa tenant epg network add ...)
6. Configure endpoint group ports (efa tenant epg port set ...)
```
Source: CLI Admin Guide p.192–291

#### Day-0: External Connectivity (BGP)
```
1. Create BGP peer group under VRF (efa tenant bgp peer-group create ...)
2. Configure prefix-list / route-map on peer group
3. Create BGP peers (static or dynamic) (efa tenant bgp peer create ...)
4. Configure BGP peer options (send-community, remove-private-as, etc.)
5. Verify operational state (efa tenant bgp peer show --operational ...)
```
Source: CLI Admin Guide p.376–444

#### Day-2: Drift and Reconcile
```
1. (Optional) Backup config (efa inventory device config-backup execute ...)
2. Execute DRC (efa inventory drift-reconcile execute --device-ip ...)
3. DRC runs in parallel across devices
4. Check device state (efa inventory device show ...)
5. If failed, replay config (efa inventory device config-replay execute ...)
```
Source: CLI Admin Guide p.97–108, 610–614

#### Day-2: Firmware Upgrade (Hitless)
```
1. Register firmware host (efa inventory firmware-host register ...)
2. Prepare switches (efa inventory firmware-download prepare ...)
3. Execute download (efa inventory firmware-download execute ...)
4. Monitor status (efa inventory firmware-download show ...)
5. Commit (efa inventory firmware-download commit ...)
6. (If fail) Restore (efa inventory firmware-download restore ...)
7. DRC after firmware activation
```
Source: CLI Admin Guide p.581–607

#### Day-2: Health Triage
```
1. Get fabric health summary (efa fabric show --name X --health)
2. Get health inventory (monitor/health-inventory API)
3. Get alarm summary (fault-manager alarm summary)
4. Get alarm history for specific resource
5. Acknowledge / close alarms
6. (Optional) DRC on affected devices
```
Source: CLI Admin Guide p.691–794

#### Platform: Backup & Restore
```
1. Create system backup (monitor/backup API)
2. List backups
3. Restore from backup
4. Monitor restore status
5. Check certificate expiry
```
Source: CLI Admin Guide p.71–87

### 2.3 API Endpoints Per Service (XCO 4.0.0)

From the official 4.0.0 API reference docs:

| Service | Endpoint Count | Key Operations |
|---------|---------------|----------------|
| **Fabric** | ~30 | createFabric, addDevicesToFabric, configureFabric, validateFabric, getFabricHealth, FabricErrors, deleteFabric |
| **Tenant** | ~50 | createTenant, createPortchannel, createVrf, createEndpointGroup, configureEndpointGroup, createBgpPeer, createBgpServicePeerGroup, getOperationalBgpPeer |
| **Inventory** | ~60 | registerSwitches, driftAndReconcile, StartConfigBackup, StartConfigReplay, executeFirmwareDownload, commitFirmwareDownload, getFirmwareDownloadStatus, switchHealthStatus |
| **Monitor** | ~20 | healthInventory, backup, restore, certificateExpiry, systemStatus |
| **Fault Manager** | ~15 | alarmSummary, getAlarmHistory, acknowledgeAlarm, closeAlarm |
| **Auth** | ~10 | login, refresh, token management |
| **RBAC** | ~15 | users, roles, permissions |
| **System** | ~10 | version, services status |
| **vCenter** | ~15 | registerVcenter, getESXiDetails, getPhysicalLinks, getVcenterEvents |
| **Hyper-V** | ~10 | register, status, links |
| **SNMP** | ~10 | proxy config, community, traps |
| **License** | ~8 | install, status, capacity |
| **Notification** | ~5 | subscribe, events |

---

## 3. Proposed Composite Tools

### Priority Tier 1 — Core Day-0/Day-2

#### 3.1 `xco_workflow_fabric_onboard`

**Purpose**: Bring a fabric from zero to operational in one call.

**Internal sequence**:
1. **Preflight checks**:
   - Does a fabric with this name already exist? → error if so
   - Are any devices already assigned to another fabric? → error with details
   - Check device inventory status (stale/incomplete entries)
2. If devices not in inventory and `auto_register=true`, call `inventory__registerswitches`
3. Verify device interfaces: `inventory__device_interface_list` for each device
4. `fabric__createfabric` with user-provided name, type, settings
5. `fabric__adddevicestofabric` with leaf/spine/border-leaf IPs
6. `fabric__validatefabric` + `fabric__validatefabricphysicaltopology`
7. If `configure=true` (default): `fabric__configurefabric`
   - Poll for async completion if configure is non-blocking
8. `fabric__getfabrichealth` + `fabric__fabricerrors`

**Compensation**: If step 5+ fails after fabric creation, return partial-state guidance (fabric exists but is unconfigured) with remediation instructions rather than attempting auto-delete.

**Input schema** (simplified):
```typescript
{
  name: string;           // Fabric name
  type: "clos-3" | "clos-5" | "small-dc";
  leaf_ips: string[];     // Leaf device IPs
  spine_ips: string[];    // Spine device IPs
  border_leaf_ips?: string[];
  super_spine_ips?: string[];  // For 5-stage
  settings?: {            // Optional fabric settings
    l2_mtu?: number;
    l3_mtu?: number;
    bgp_max_paths?: number;
    anycast_mac?: string;
    md5_password?: string;
  };
  auto_register?: boolean;    // Auto-register devices not in inventory
  device_username?: string;   // For auto-register
  device_password?: string;
  configure?: boolean;        // Run configure after validate (default: true)
  plan_only?: boolean;        // Only show what would be done
}
```

**Output**: Combined result with fabric details, health status, any errors, and step-by-step log.

---

#### 3.2 `xco_workflow_tenant_bootstrap`

**Purpose**: Create a fully functional tenant with VRFs, endpoint groups, and port channels.

**Internal sequence**:
1. `tenant__createtenant` with name, type, VLAN range, L2/L3 VNI ranges
2. For each port channel: `tenant__createportchannel`
3. For each VRF: `tenant__createvrf`
4. For each endpoint group: `tenant__createendpointgroup`
5. Configure EPG networks: `tenant__configureendpointgroup` (network property)
6. Configure EPG ports: `tenant__configureendpointgroup` (port property)
7. Configure VRFs: `tenant__configurevrf`

**Partial-failure strategy**: This workflow is explicitly **best-effort**. If a step fails after tenant creation, the workflow:
- Records all successful steps and their results in `artifacts`
- Returns `success: false` with a `partial_state` summary showing what was created
- Includes remediation guidance: "Tenant 'X' was created but VRF 'Y' failed. You can fix the input and retry the VRF creation directly with `tenant__createvrf`."
- Does NOT attempt auto-cleanup (deleting the tenant) because partial state may be intentional in iterative provisioning

**Input schema**:
```typescript
{
  tenant: {
    name: string;
    type: "vlan" | "bd";
    vlan_range: string;       // e.g. "100-200"
    l2_vni_range?: string;
    l3_vni_range?: string;
    vrf_count?: number;
    port_count?: number;
  };
  vrfs?: Array<{
    name: string;
    rt_type?: string;
    local_asn?: number;
    max_paths?: number;
  }>;
  endpoint_groups?: Array<{
    name: string;
    vrf: string;
    networks?: Array<{ vlan: number; ip?: string; }>;
    ports?: Array<{ device_ip: string; interface: string; }>;
  }>;
  port_channels?: Array<{
    name: string;
    interfaces: string[];
    min_links?: number;
    mtu?: number;
  }>;
  plan_only?: boolean;
}
```

---

#### 3.3 `xco_workflow_drift_reconcile`

**Purpose**: Safe drift-and-reconcile with optional backup-first and rollback.

**Internal sequence**:
1. If `backup_first=true` (default): `inventory__startconfigbackup` for each device
   - **Capture backup IDs** in `artifacts.backup_ids` for later replay reference
2. `inventory__driftandreconcile` with `reconcile=true`
   - Poll via `inventory__device_current_state` until terminal state
3. Check `inventory__switchhealthstatus` for each device
4. If any device unhealthy and `auto_rollback=true`:
   - Execute `inventory__startconfigreplay` using the backup IDs from step 1
   - If `auto_rollback=false` (default), return backup IDs with a "suggest replay" message

**Key detail**: Step 1 backup IDs are returned in `artifacts` even on success, so the agent or operator can manually replay later if a delayed problem surfaces.

**Input schema**:
```typescript
{
  scope: "device" | "fabric";
  device_ips?: string[];       // For device scope
  fabric_name?: string;        // For fabric scope
  backup_first?: boolean;      // Default: true
  reconcile?: boolean;         // Default: true (false = drift check only)
  auto_rollback?: boolean;     // Default: false (suggest only)
  plan_only?: boolean;
  confirmed_plan_token?: string;
}
```

---

### Priority Tier 2 — Day-2 Operations

#### 3.4 `xco_workflow_firmware_upgrade`

**Purpose**: End-to-end firmware upgrade with health checks.

**Sequence**: Register firmware host → Prepare → Execute → Monitor → Commit/Activate → DRC → Health check

**Key features**: Hitless upgrade support (maintenance mode), group-based execution, automatic restore on failure.

#### 3.5 `xco_workflow_bgp_connectivity`

**Purpose**: Set up external connectivity (BGP peers + peer groups) for a tenant VRF.

**Sequence**: Create peer group → Configure prefix-list/route-map → Create peers → Configure peer options → Verify operational state

#### 3.6 `xco_workflow_incident_triage` ⭐ Phase 1 Proving Ground

**Purpose**: Comprehensive health and fault assessment for a fabric. **Entirely read-only** — no mutations, no confirmation needed.

**Why this is Phase 1**: As the only purely read-only workflow, it validates the entire engine pipeline (capability check, step execution, result aggregation, event streaming) without risking any state changes. If the engine has bugs, they surface here safely.

**Internal sequence**:
1. `fabric__getfabrichealth` — overall fabric health status
2. `monitor__gethealthinventory` — device health inventory
3. `monitor__get_monitor_all` — full system monitor status
4. `faultmanager__alarmsummary` — alarm counts by severity
5. `faultmanager__getalarmhistory` — recent alarm events
6. Aggregate results into prioritized issue list with severity, affected resources, and suggested next actions

**Output**: Structured triage report with sections: fabric health, device health, active alarms, recommended actions.

---

### Priority Tier 3 — Platform & Integration

#### 3.7 `xco_workflow_platform_backup`

**Purpose**: Complete platform backup with health check.

**Sequence**: System backup → List/verify → Certificate expiry check → Output summary

#### 3.8 `xco_workflow_vcenter_audit`

**Purpose**: Audit vCenter integration health.

**Sequence**: Get vCenter details → ESXi details → Physical/Virtual links → Unconnected NICs → Recent events → Output connectivity report

---

## 4. Architecture Design

### 4.1 Where Composite Tools Live

```
src/
  lib/
    runtime.ts          ← existing: meta tools + generated tool routing
    openapi.ts          ← existing: spec → generated tools
    workflows/          ← NEW: composite tool implementations
      index.ts          ← workflow registry + type exports
      types.ts          ← WorkflowStep, WorkflowResult, WorkflowOptions
      fabric-onboard.ts
      tenant-bootstrap.ts
      drift-reconcile.ts
      firmware-upgrade.ts
      bgp-connectivity.ts
      incident-triage.ts
      platform-backup.ts
      vcenter-audit.ts
```

### 4.2 Workflow Tool Registration

Composite tools register as a third category alongside meta and generated tools:

```typescript
// In runtime.ts — extend callTool routing
async callTool(name: string, input: ToolInput, options: RuntimeCallOptions) {
  if (META_TOOL_NAMES.has(name)) {
    return this.callMetaTool(name, input, options);
  }
  if (WORKFLOW_TOOL_NAMES.has(name)) {
    return this.callWorkflowTool(name, input, options);  // NEW
  }
  return this.callGeneratedTool(name, input, options);
}
```

Workflow tools are **NOT** always available. Each workflow declares its required and optional generated tool dependencies. At `getTools()` time:

- **Preflight capability check**: If any *required* generated tool is missing from the active version's `operationMap`, the workflow is **hidden** from `getTools()` and will **fail with a clear error** if called directly.
- **Optional step degradation**: Steps depending on *optional* tools are skipped with a warning.
- **Readonly filtering**: Workflow tools that mutate state are excluded when `config.readonly=true`, consistent with generated tool filtering.

```typescript
// Each workflow declares its capabilities
interface WorkflowDefinition extends ToolDefinition {
  mutates: boolean;                    // Used for readonly filtering
  requiredTools: string[];             // Must exist in operationMap
  optionalTools: string[];             // May be skipped if unavailable
  supportedVersions?: string[];        // Optional version whitelist
}
```

### 4.3 Workflow Execution Engine

Each workflow tool is a function with this signature:

```typescript
interface WorkflowContext {
  runtime: XcoRuntime;
  input: ToolInput;
  options: RuntimeCallOptions;
  emit: (event: WorkflowEvent) => void;
  availableTools: Set<string>;         // Tools in current operationMap
}

interface WorkflowStep {
  id: string;
  label: string;
  tool: string;                        // Generated tool name to call
  input: ToolInput | ((priorResults: Map<string, unknown>) => ToolInput);
  required: boolean;                   // If true, failure = abort workflow
  condition?: (ctx: WorkflowContext, priorResults: Map<string, unknown>) => boolean;
  onError: "abort" | "skip" | "compensate";
  compensate?: WorkflowStep;           // Undo step on failure
  pollUntil?: {                        // For async operations
    tool: string;                      // Status-check tool
    input: ToolInput;
    predicate: (result: unknown) => boolean;
    intervalMs: number;
    timeoutMs: number;
  };
  retries?: number;                    // Retry count (default: 0)
  retryDelayMs?: number;
}

interface WorkflowResult {
  success: boolean;
  steps: Array<{
    id: string;
    label: string;
    status: "ok" | "skipped" | "failed" | "compensated";
    result?: unknown;
    error?: string;
    duration_ms: number;
  }>;
  summary: Record<string, unknown>;
  artifacts: Record<string, unknown>;  // e.g. backup IDs for rollback
}

type WorkflowFn = (ctx: WorkflowContext) => Promise<WorkflowResult>;
```

### 4.4 Cross-Cutting Features

All workflow tools share these behaviors:

| Feature | Description | Default |
|---------|-------------|---------|
| `plan_only` | Return exact plan with args (redacted), no execution | `false` |
| `confirmed_plan_token` | Required to execute after `plan_only` | — |
| `validate_only` | Run only validation/read steps | `false` |
| `rollback_policy` | "none" / "suggest" / "auto" | `"suggest"` |
| Event streaming | Each step emits progress via `onEvent` | Always on |
| Readonly enforcement | Mutating workflows blocked when `readonly=true` | Enforced |
| Capability preflight | Check required tools exist before execution | Always |
| Compensation | Failed steps with `compensate` are undone | Per-step |

> **Note on confirmation UX**: We do NOT use SSE pause/resume for confirmation. Instead, the
> strict two-call pattern (plan → confirm) gives agents and users a safe review gate. See §4.5.

> **Note on checkpoint/resume**: Deferred to a future phase. Step results are logged for
> debugging but workflow state is NOT persisted across process restarts.

### 4.5 Two-Call Confirmation Pattern

For agent safety, mutating workflows use a strict two-call flow:

**Call 1 — Plan**:
```typescript
// Agent calls with plan_only=true
xco_workflow_fabric_onboard({ name: "dc-west", ..., plan_only: true })
```
Returns:
```json
{
  "plan_token": "sha256:abc123...",
  "plan": [
    { "step": 1, "action": "inventory__registerswitches", "args": { "ips": ["10.0.0.1", "..."] }, "required": true },
    { "step": 2, "action": "fabric__createfabric", "args": { "name": "dc-west", "type": "clos-3" }, "required": true },
    { "step": 3, "action": "fabric__adddevicestofabric", "args": { "leaf": "...", "spine": "..." }, "required": true },
    { "step": 4, "action": "fabric__validatefabric", "args": {}, "required": true },
    { "step": 5, "action": "fabric__configurefabric", "args": {}, "required": true },
    { "step": 6, "action": "fabric__getfabrichealth", "args": {}, "required": false }
  ],
  "capability_check": { "all_required": true, "missing_optional": [] },
  "warnings": ["Device 10.0.0.3 not found in inventory — will auto-register"],
  "estimated_calls": 6,
  "mutates": true
}
```

**Call 2 — Execute**:
```typescript
// Agent calls again with the plan token to confirm execution
xco_workflow_fabric_onboard({ ..., confirmed_plan_token: "sha256:abc123..." })
```

The token is a hash of the plan + input, ensuring the exact plan the user reviewed is what executes. If input changed, the token won't match and execution is rejected.

---

## 5. Compatibility Considerations

### 5.1 Version Adaptability

Composite tools use a **fail-safe** capability model:

- **Required mutating steps**: If any required generated tool is missing from `operationMap`, the workflow **fails at preflight** with a clear "unsupported version" error. It is also hidden from `getTools()`.
- **Optional read/check steps**: May be skipped with a warning in the result.
- **Schema differences**: Older versions may not support certain parameters. Workflow implementations should use defensive input construction and test against real spec bundles (not just mocks).
- **Contract testing**: Unit mocks alone won't catch version drift. Integration tests should load real spec bundles from `specs/` or downloaded versions to verify tool names and schemas match workflow expectations.

### 5.2 Generated Tool Dependency

Composite tools call generated tools via `this.callGeneratedTool()`, NOT raw HTTP. This ensures:
- Auth is handled automatically (token refresh, etc.)
- Readonly mode is enforced
- SSH tunnels are used if configured
- Request logging captures all calls
- Event streaming works end-to-end

### 5.3 Naming Convention

All composite tools use the prefix `xco_workflow_` to distinguish them from:
- `xco_*` meta tools (system management)
- `<service>__<operation>` generated tools (API operations)

---

## 6. Testing Strategy

### 6.1 Unit Tests

Each workflow module gets its own test file:
```
test/
  workflows/
    fabric-onboard.test.ts
    tenant-bootstrap.test.ts
    drift-reconcile.test.ts
    ...
```

Tests mock `callGeneratedTool()` to simulate API responses and verify:
- Correct step ordering
- Error handling (step failure, compensation)
- Plan-only mode output + plan-token verification
- Two-call confirmation flow (plan → token → execute)
- Readonly enforcement (mutating workflows blocked)
- Capability preflight (missing required tools → hidden + error)
- Polling/timeout behavior (for async operations)
- Partial-failure state reporting

### 6.2 Contract Tests

Load real OpenAPI spec bundles from `specs/` and verify:
- All `requiredTools` declared by each workflow exist in the loaded `operationMap`
- Tool input schemas match what the workflow would pass (catch version drift)
- Run against every available spec version to detect compatibility gaps early

### 6.3 Integration Tests

Extend existing `test/integration.test.ts` mock server to include fabric/inventory/monitor endpoints, then test full workflow execution against mock APIs.

### 6.4 E2E Tests

On real XCO clusters (via SSH tunnel + credentials), run workflow tools in `plan_only` mode to verify they correctly compose the generated tools. Selected read-only workflows (incident triage, vcenter audit) can be tested fully.

---

## 7. Implementation Roadmap

### Phase 1: Foundation + Proving Ground
- Create `src/lib/workflows/` module structure
- Implement `WorkflowContext`, `WorkflowResult`, `WorkflowStep`, `WorkflowDefinition` types
- Add `WORKFLOW_TOOL_NAMES` and `callWorkflowTool()` routing in runtime.ts
- Add capability preflight, `plan_only`, two-call confirmation, and step execution engine
- Update `getTools()` to include workflow tools (with capability + readonly filtering)
- **First workflow**: `xco_workflow_incident_triage` (read-only — safest proving ground for the engine)
- Unit tests + integration tests for incident_triage and the engine itself
- **Why incident_triage first**: It's entirely read-only (no confirmation needed, no rollback, no compensation), exercises the full engine pipeline, and produces immediately useful output. This validates the engine before any mutating workflow is attempted.

### Phase 2: Core Provisioning Workflows (Tier 1)
- Implement `xco_workflow_fabric_onboard` (with two-call confirmation, compensation guidance)
- Implement `xco_workflow_tenant_bootstrap` (with partial-failure strategy)
- Unit tests for each (mock `callGeneratedTool`, test plan/confirm/execute/error paths)
- Integration tests with mock server
- **Contract tests**: Load real spec bundles from `specs/` to verify tool name/schema expectations

### Phase 3: Day-2 Operations (Tier 2)
- Implement `xco_workflow_drift_reconcile` (backup artifact tracking, conditional rollback)
- Implement `xco_workflow_firmware_upgrade` (polling, restore-on-failure)
- Implement `xco_workflow_bgp_connectivity`
- Tests for each, including polling/timeout edge cases

### Phase 4: Platform Workflows (Tier 3)
- Implement `xco_workflow_platform_backup`
- Implement `xco_workflow_vcenter_audit`
- Tests

### Phase 5: Documentation & CI
- Update AGENT.md with workflow tool descriptions
- Update wiki (MCP Integration, Architecture pages)
- Add workflow tests to CI pipeline
- Update README with workflow examples

---

## 8. Open Questions

1. **Custom workflows**: Should users be able to define their own composite tools via configuration (e.g. YAML workflow definitions), or is code-only acceptable for now? Code-only is recommended for Phase 1 to keep the execution model simple.

2. **Version-specific workflow variants**: Some XCO versions have different API shapes. Recommended approach: runtime capability detection via `operationMap.has()` + schema inspection, rather than maintaining version-specific forks. Version whitelist in `WorkflowDefinition.supportedVersions` is an escape hatch for known-broken combinations.

3. **Checkpoint/resume**: Deferred. Step results are logged via `onEvent` for debugging and audit, but workflow state is NOT persisted across process restarts. This can be added in a future phase once persistence semantics (where to store, how to clean up) are defined.

4. **MCP sampling integration**: The MCP spec defines optional `sampling` and `roots` capabilities. If future MCP clients support human-in-the-loop confirmation, the two-call pattern can be enhanced to use it. For now, the plan-token approach works with any MCP client.

---

## 9. References

- XCO 4.0.0 CLI Administration Guide (530+ pages, 542 TOC entries)
- XCO 4.0.0 GUI Administration Guide (119 TOC entries)
- XCO 4.0.0 API References: Fabric, Tenant, Inventory, Monitor, Fault Manager, Auth, RBAC, System, vCenter, Hyper-V, SNMP, License, Notification
- EFA 2.2.0 – 3.1.0 Admin Guides (for version compatibility research)
- XCO 3.7.0 Admin Guides (for version compatibility research)
- Current codebase: `src/lib/runtime.ts` (meta tool pattern), `src/lib/openapi.ts` (generated tool pattern)

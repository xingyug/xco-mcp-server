import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { createRuntime } from "../src/lib/runtime.js";
import { loadOperations } from "../src/lib/openapi.js";
import type { XcoConfig } from "../src/types.js";

/**
 * Create an isolated env that points XCO_HOME to a temp dir (no downloaded
 * versions) and XCO_CONFIG to a nonexistent file so only the bundled
 * specs/ directory is used.
 */
async function isolatedEnv(): Promise<{ env: Record<string, string | undefined>; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-rt-test-"));
  return {
    env: {
      ...process.env,
      XCO_HOME: tmpDir,
      XCO_CONFIG: path.join(tmpDir, "config.json"),
    },
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

void test("runtime loads manual specs and generates tools", async () => {
  const { env, cleanup } = await isolatedEnv();
  try {
    const runtime = await createRuntime({ cwd: process.cwd(), env });

    assert.equal(runtime.specEntries.length, 1);
    assert.equal(runtime.operations.length, 3);
    assert.ok(runtime.operationMap.has("tenant_service__gettenants"));
    assert.equal(
      runtime.operationMap.get("tenant_service__gettenants")!.operation
        .requiresAuth,
      true,
    );
    assert.equal(
      runtime.operationMap.get("tenant_service__gethealth")!.operation
        .requiresAuth,
      false,
    );

    const tools = runtime.getTools();
    assert.ok(tools.find((tool) => tool.name === "xco_setup_version"));
    assert.ok(tools.find((tool) => tool.name === "xco_auth_login"));
    assert.ok(tools.find((tool) => tool.name === "tenant_service__gettenants"));
  } finally {
    await cleanup();
  }
});

void test("runtime readonly mode only exposes read operations and blocks writes", async () => {
  const { env, cleanup } = await isolatedEnv();
  try {
    env.XCO_READONLY = "true";
    const runtime = await createRuntime({ cwd: process.cwd(), env });

    const tools = runtime.getTools();
    assert.ok(tools.find((tool) => tool.name === "tenant_service__gettenants"));
    assert.equal(
      tools.find((tool) => tool.name === "tenant_service__createtenant"),
      undefined,
    );

    await assert.rejects(
      runtime.callTool("tenant_service__createtenant", {
        body: {
          name: "Tenant-1",
        },
      }),
      /Readonly mode is enabled/,
    );
  } finally {
    await cleanup();
  }
});

void test("operationRequiresAuth falls back to securitySchemes when security array is missing", async () => {
  // Create a temp dir with only the monitor fixture (has securitySchemes but no top-level security)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-auth-test-"));
  try {
    await fs.cp(
      path.join(process.cwd(), "test", "fixtures", "monitor-service-fixture.json"),
      path.join(tmpDir, "monitor-service-fixture.json"),
    );

    const config: Partial<XcoConfig> = {
      manualSpecsDir: tmpDir,
      xcoHome: tmpDir,
    };
    const { operations } = await loadOperations(config as XcoConfig);

    // getHealth has no operation-level security, so it should fall back to securitySchemes → require auth
    const healthOp = operations.find((e) => e.name === "monitor_service__gethealth");
    assert.ok(healthOp, "monitor_service__gethealth should exist");
    assert.equal(
      healthOp.operation.requiresAuth,
      true,
      "Expected getHealth to require auth (securitySchemes fallback)",
    );

    // getAllStatus has explicit security: [] (no auth required)
    const statusOp = operations.find((e) => e.name === "monitor_service__getallstatus");
    assert.ok(statusOp, "monitor_service__getallstatus should exist");
    assert.equal(
      statusOp.operation.requiresAuth,
      false,
      "Expected getAllStatus to not require auth (explicit empty security)",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

void test("callMetaTool normalizes snake_case keys to camelCase", async () => {
  const { env, cleanup } = await isolatedEnv();
  try {
    const runtime = await createRuntime({ cwd: process.cwd(), env });

    // xco_list_versions doesn't need any params — just verify it works with snake_case
    const result = await runtime.callMetaTool("xco_list_versions", {}, {});
    assert.ok(result !== undefined);

    // Test that snake_case params are correctly normalized by trying xco_describe_bundle
    // with snake_case key — it should not throw a parameter error
    const result2 = await runtime.callMetaTool(
      "xco_describe_bundle",
      { version_slug: "bundled", include_schemas: false },
      {},
    );
    assert.ok(result2 !== undefined);
  } finally {
    await cleanup();
  }
});

void test("callTool throws on missing required query parameter", async () => {
  const { env, cleanup } = await isolatedEnv();
  try {
    // Create an isolated specs dir with only the monitor fixture
    const specsDir = path.join(env.XCO_HOME!, "test-specs");
    await fs.mkdir(specsDir, { recursive: true });
    await fs.cp(
      path.join(process.cwd(), "test", "fixtures", "monitor-service-fixture.json"),
      path.join(specsDir, "monitor-service-fixture.json"),
    );

    // Set base URL so we get past URL validation to param validation
    env.XCO_BASE_URL = "http://localhost:9999";

    const runtime = await createRuntime({
      cwd: process.cwd(),
      env: { ...env, XCO_SPECS_DIR: specsDir },
    });

    // Verify the monitor tool was loaded
    assert.ok(
      runtime.operationMap.has("monitor_service__getallstatus"),
      "monitor_service__getallstatus should be loaded",
    );

    // This should throw because 'resource' is required
    await assert.rejects(
      runtime.callTool("monitor_service__getallstatus", {}),
      /Missing required parameter "resource"/,
    );
  } finally {
    await cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { createRuntime } from "../src/lib/runtime.js";

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

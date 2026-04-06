import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../src/lib/runtime.js";

test("runtime loads manual specs and generates tools", async () => {
  const runtime = await createRuntime({
    cwd: process.cwd(),
    env: {
      ...process.env,
      XCO_CONFIG: "./.xco-test-does-not-exist.json",
    },
  });

  assert.equal(runtime.specEntries.length, 1);
  assert.equal(runtime.operations.length, 3);
  assert.ok(runtime.operationMap.has("tenant_service__gettenants"));
  assert.equal(
    runtime.operationMap.get("tenant_service__gettenants").operation
      .requiresAuth,
    true,
  );
  assert.equal(
    runtime.operationMap.get("tenant_service__gethealth").operation
      .requiresAuth,
    false,
  );

  const tools = runtime.getTools();
  assert.ok(tools.find((tool) => tool.name === "xco_setup_version"));
  assert.ok(tools.find((tool) => tool.name === "xco_auth_login"));
  assert.ok(tools.find((tool) => tool.name === "tenant_service__gettenants"));
});

test("runtime readonly mode only exposes read operations and blocks writes", async () => {
  const runtime = await createRuntime({
    cwd: process.cwd(),
    env: {
      ...process.env,
      XCO_CONFIG: "./.xco-test-does-not-exist.json",
      XCO_READONLY: "true",
    },
  });

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
});

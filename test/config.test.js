import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { saveConfig } from "../src/lib/config.js";

test("saveConfig does not persist plaintext bastion passwords", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-config-test-"));
  const configPath = path.join(tempDir, "config.json");

  await saveConfig(
    {
      configPath,
    },
    {
      activeVersion: "3.7.0",
      bastionPassword: "super-secret",
      bastionPasswordEnv: "XCO_BASTION_PASSWORD",
      bastionPasswordAuth: true,
    },
  );

  const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(persisted.bastionPassword, undefined);
  assert.equal(persisted.bastionPasswordEnv, "XCO_BASTION_PASSWORD");
  assert.equal(persisted.bastionPasswordAuth, true);
});

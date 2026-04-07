import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { readJson, writeJson, parseJsonText, tryParseJson, isParseFailure } from "../src/lib/json.js";

void describe("readJson", () => {
  void it("reads and parses valid JSON file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-json-"));
    const filePath = path.join(tmpDir, "test.json");
    try {
      await fs.writeFile(filePath, '{"key":"value"}');
      const result = await readJson(filePath);
      assert.deepEqual(result, { key: "value" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("throws for invalid JSON file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-json-"));
    const filePath = path.join(tmpDir, "bad.json");
    try {
      await fs.writeFile(filePath, "{not valid json}");
      await assert.rejects(() => readJson(filePath), /Invalid JSON/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("throws for missing file", async () => {
    await assert.rejects(() => readJson("/tmp/nonexistent-xco-json-file.json"));
  });
});

void describe("writeJson", () => {
  void it("writes formatted JSON and creates parent directories", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-json-"));
    const filePath = path.join(tmpDir, "sub", "out.json");
    try {
      await writeJson(filePath, { hello: "world" });
      const content = await fs.readFile(filePath, "utf8");
      assert.ok(content.includes('"hello": "world"'));
      assert.ok(content.endsWith("\n"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

void describe("parseJsonText", () => {
  void it("parses valid JSON text", () => {
    assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  });

  void it("throws with label for invalid JSON", () => {
    assert.throws(() => parseJsonText("{bad}", "config"), /Failed to parse config/);
  });
});

void describe("tryParseJson / isParseFailure", () => {
  void it("returns parsed value for valid JSON", () => {
    const result = tryParseJson('{"a":1}');
    assert.equal(isParseFailure(result), false);
    assert.deepEqual(result, { a: 1 });
  });

  void it("returns parse failure sentinel for invalid JSON", () => {
    const result = tryParseJson("{bad}");
    assert.equal(isParseFailure(result), true);
  });

  void it("correctly handles valid JSON null without conflation", () => {
    const result = tryParseJson("null");
    assert.equal(isParseFailure(result), false);
    assert.equal(result, null);
  });

  void it("correctly handles valid JSON false", () => {
    const result = tryParseJson("false");
    assert.equal(isParseFailure(result), false);
    assert.equal(result, false);
  });

  void it("correctly handles valid JSON 0", () => {
    const result = tryParseJson("0");
    assert.equal(isParseFailure(result), false);
    assert.equal(result, 0);
  });

  void it("isParseFailure returns false for normal values", () => {
    assert.equal(isParseFailure(null), false);
    assert.equal(isParseFailure(undefined), false);
    assert.equal(isParseFailure(0), false);
    assert.equal(isParseFailure(""), false);
  });
});

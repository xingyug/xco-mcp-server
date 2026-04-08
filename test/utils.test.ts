import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  slugify,
  versionToSlug,
  versionToSupportPath,
  buildSupportDocsUrl,
  summarizeText,
  inferServiceSlugFromTitle,
  fileExists,
  listJsonFiles,
  mergeDefined,
  makeToolName,
  pickJsonContentType,
  getContentSchema,
  encodeQueryValue,
  ensureObject,
  toAbsolutePath,
  uniqueBy,
  normalizeKeys,
} from "../src/lib/utils.js";

void describe("slugify", () => {
  void it("lowercases and replaces spaces with dashes", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  void it("collapses multiple separators", () => {
    assert.equal(slugify("foo--bar__baz  qux"), "foo-bar-baz-qux");
  });

  void it("strips non-word characters", () => {
    assert.equal(slugify("API (v2)"), "api-v2");
  });

  void it("handles empty string", () => {
    assert.equal(slugify(""), "");
  });
});

void describe("versionToSlug / versionToSupportPath / buildSupportDocsUrl", () => {
  void it("preserves version as slug", () => {
    assert.equal(versionToSlug("3.7.0"), "3.7.0");
  });

  void it("replaces dots with dashes for support path", () => {
    assert.equal(versionToSupportPath("3.7.0"), "3-7-0");
  });

  void it("builds correct support docs URL", () => {
    const url = buildSupportDocsUrl("3.7.0");
    assert.ok(url.includes("extremecloud-orchestrator-3-7-0"));
    assert.ok(url.startsWith("https://"));
  });
});

void describe("summarizeText", () => {
  void it("collapses whitespace", () => {
    assert.equal(summarizeText("  hello   world  "), "hello world");
  });

  void it("returns fallback for falsy values", () => {
    assert.equal(summarizeText(null, "n/a"), "n/a");
    assert.equal(summarizeText("", "n/a"), "n/a");
    assert.equal(summarizeText(undefined), "");
  });
});

void describe("inferServiceSlugFromTitle", () => {
  void it("strips XCO prefix and service suffix", () => {
    const result = inferServiceSlugFromTitle(
      "ExtremeCloud Orchestrator Tenant Service API Reference v3.7.0",
      "https://example.com/tenant.html",
    );
    assert.equal(result, "tenant");
  });

  void it("falls back to URL basename when title is empty", () => {
    const result = inferServiceSlugFromTitle(
      "",
      "https://example.com/docs/network-policy.html",
    );
    assert.equal(result, "network-policy");
  });
});

void describe("fileExists", () => {
  void it("returns true for existing file", async () => {
    assert.equal(await fileExists(path.resolve("package.json")), true);
  });

  void it("returns false for missing file", async () => {
    assert.equal(await fileExists("/tmp/nonexistent-xco-test-file"), false);
  });
});

void describe("listJsonFiles", () => {
  void it("finds .json files in a directory tree", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xco-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "a.json"), "{}");
      await fs.mkdir(path.join(tmpDir, "sub"));
      await fs.writeFile(path.join(tmpDir, "sub", "b.json"), "{}");
      await fs.writeFile(path.join(tmpDir, "c.txt"), "text");

      const files = await listJsonFiles(tmpDir);
      assert.equal(files.length, 2);
      assert.ok(files[0].endsWith("a.json"));
      assert.ok(files[1].endsWith("b.json"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  void it("returns empty array for missing directory", async () => {
    const files = await listJsonFiles("/tmp/nonexistent-xco-test-dir");
    assert.deepEqual(files, []);
  });
});

void describe("mergeDefined", () => {
  void it("merges defined keys and skips undefined", () => {
    const result = mergeDefined(
      { a: 1, b: undefined },
      { b: 2, c: 3 },
    );
    assert.deepEqual(result, { a: 1, b: 2, c: 3 });
  });

  void it("skips null/non-object arguments", () => {
    const result = mergeDefined(null, undefined, { x: 1 });
    assert.deepEqual(result, { x: 1 });
  });
});

void describe("makeToolName", () => {
  void it("uses operationId when available", () => {
    assert.equal(
      makeToolName("tenant-service", "getTenants", "get", "/tenants"),
      "tenant_service__gettenants",
    );
  });

  void it("falls back to method + route when operationId is null", () => {
    const name = makeToolName("my-svc", null, "post", "/items");
    assert.ok(name.startsWith("my_svc__"));
    assert.ok(name.includes("post"));
  });
});

void describe("pickJsonContentType / getContentSchema", () => {
  void it("returns application/json when present", () => {
    assert.equal(
      pickJsonContentType({ "application/json": { schema: {} } }),
      "application/json",
    );
  });

  void it("returns first key when no application/json", () => {
    assert.equal(
      pickJsonContentType({ "text/plain": {} }),
      "text/plain",
    );
  });

  void it("returns null for empty content", () => {
    assert.equal(pickJsonContentType({}), null);
  });

  void it("getContentSchema extracts schema", () => {
    const result = getContentSchema({
      "application/json": { schema: { type: "object" } },
    });
    assert.equal(result.contentType, "application/json");
    assert.deepEqual(result.schema, { type: "object" });
  });
});

void describe("encodeQueryValue", () => {
  void it("appends string value", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "q", "hello");
    assert.equal(sp.get("q"), "hello");
  });

  void it("appends array items individually", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "id", [1, 2, 3]);
    assert.deepEqual(sp.getAll("id"), ["1", "2", "3"]);
  });

  void it("JSON-stringifies object values", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "filter", { x: 1 });
    assert.equal(sp.get("filter"), '{"x":1}');
  });

  void it("skips null and undefined", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "a", null);
    encodeQueryValue(sp, "b", undefined);
    assert.equal(sp.toString(), "");
  });
});

void describe("ensureObject", () => {
  void it("returns object for valid input", () => {
    const obj = { a: 1 };
    assert.equal(ensureObject(obj, "test"), obj);
  });

  void it("throws for array", () => {
    assert.throws(() => ensureObject([1, 2], "test"), /must be an object/);
  });

  void it("throws for string", () => {
    assert.throws(() => ensureObject("str", "test"), /must be an object/);
  });

  void it("throws for null", () => {
    assert.throws(() => ensureObject(null, "test"), /must be an object/);
  });
});

void describe("toAbsolutePath", () => {
  void it("returns null for null/undefined/empty", () => {
    assert.equal(toAbsolutePath("/cwd", null), null);
    assert.equal(toAbsolutePath("/cwd", undefined), null);
    assert.equal(toAbsolutePath("/cwd", ""), null);
  });

  void it("expands ~ to homedir", () => {
    assert.equal(toAbsolutePath("/cwd", "~"), os.homedir());
  });

  void it("expands ~/path to homedir-relative", () => {
    assert.equal(
      toAbsolutePath("/cwd", "~/foo"),
      path.join(os.homedir(), "foo"),
    );
  });

  void it("returns absolute path as-is", () => {
    assert.equal(toAbsolutePath("/cwd", "/absolute/path"), "/absolute/path");
  });

  void it("resolves relative path against cwd", () => {
    assert.equal(
      toAbsolutePath("/some/dir", "relative/path"),
      path.resolve("/some/dir", "relative/path"),
    );
  });
});

void describe("uniqueBy", () => {
  void it("deduplicates by key", () => {
    const items = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "a", v: 3 },
    ];
    const result = uniqueBy(items, (i) => i.id);
    assert.equal(result.length, 2);
    assert.equal(result[0].v, 1);
    assert.equal(result[1].v, 2);
  });
});

void describe("normalizeKeys", () => {
  void it("converts snake_case to camelCase", () => {
    const result = normalizeKeys({ base_url: "http://x", service_prefix: "/v1" });
    assert.deepEqual(result, { baseUrl: "http://x", servicePrefix: "/v1" });
  });

  void it("passes through existing camelCase keys", () => {
    const result = normalizeKeys({ baseUrl: "http://x", simpleKey: 42 });
    assert.deepEqual(result, { baseUrl: "http://x", simpleKey: 42 });
  });

  void it("camelCase wins when both forms exist", () => {
    const result = normalizeKeys({ base_url: "snake", baseUrl: "camel" });
    assert.equal(result.baseUrl, "camel");
  });

  void it("handles keys with no underscores", () => {
    const result = normalizeKeys({ name: "test", count: 5 });
    assert.deepEqual(result, { name: "test", count: 5 });
  });

  void it("handles empty object", () => {
    assert.deepEqual(normalizeKeys({}), {});
  });

  void it("handles multiple underscores", () => {
    const result = normalizeKeys({ tls_reject_unauthorized: false });
    assert.equal(result.tlsRejectUnauthorized, false);
  });
});

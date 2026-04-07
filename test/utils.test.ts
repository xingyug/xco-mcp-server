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
} from "../src/lib/utils.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("collapses multiple separators", () => {
    assert.equal(slugify("foo--bar__baz  qux"), "foo-bar-baz-qux");
  });

  it("strips non-word characters", () => {
    assert.equal(slugify("API (v2)"), "api-v2");
  });

  it("handles empty string", () => {
    assert.equal(slugify(""), "");
  });
});

describe("versionToSlug / versionToSupportPath / buildSupportDocsUrl", () => {
  it("preserves version as slug", () => {
    assert.equal(versionToSlug("3.7.0"), "3.7.0");
  });

  it("replaces dots with dashes for support path", () => {
    assert.equal(versionToSupportPath("3.7.0"), "3-7-0");
  });

  it("builds correct support docs URL", () => {
    const url = buildSupportDocsUrl("3.7.0");
    assert.ok(url.includes("extremecloud-orchestrator-3-7-0"));
    assert.ok(url.startsWith("https://"));
  });
});

describe("summarizeText", () => {
  it("collapses whitespace", () => {
    assert.equal(summarizeText("  hello   world  "), "hello world");
  });

  it("returns fallback for falsy values", () => {
    assert.equal(summarizeText(null, "n/a"), "n/a");
    assert.equal(summarizeText("", "n/a"), "n/a");
    assert.equal(summarizeText(undefined), "");
  });
});

describe("inferServiceSlugFromTitle", () => {
  it("strips XCO prefix and service suffix", () => {
    const result = inferServiceSlugFromTitle(
      "ExtremeCloud Orchestrator Tenant Service API Reference v3.7.0",
      "https://example.com/tenant.html",
    );
    assert.equal(result, "tenant");
  });

  it("falls back to URL basename when title is empty", () => {
    const result = inferServiceSlugFromTitle(
      "",
      "https://example.com/docs/network-policy.html",
    );
    assert.equal(result, "network-policy");
  });
});

describe("fileExists", () => {
  it("returns true for existing file", async () => {
    assert.equal(await fileExists(path.resolve("package.json")), true);
  });

  it("returns false for missing file", async () => {
    assert.equal(await fileExists("/tmp/nonexistent-xco-test-file"), false);
  });
});

describe("listJsonFiles", () => {
  it("finds .json files in a directory tree", async () => {
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

  it("returns empty array for missing directory", async () => {
    const files = await listJsonFiles("/tmp/nonexistent-xco-test-dir");
    assert.deepEqual(files, []);
  });
});

describe("mergeDefined", () => {
  it("merges defined keys and skips undefined", () => {
    const result = mergeDefined(
      { a: 1, b: undefined },
      { b: 2, c: 3 },
    );
    assert.deepEqual(result, { a: 1, b: 2, c: 3 });
  });

  it("skips null/non-object arguments", () => {
    const result = mergeDefined(null, undefined, { x: 1 });
    assert.deepEqual(result, { x: 1 });
  });
});

describe("makeToolName", () => {
  it("uses operationId when available", () => {
    assert.equal(
      makeToolName("tenant-service", "getTenants", "get", "/tenants"),
      "tenant_service__gettenants",
    );
  });

  it("falls back to method + route when operationId is null", () => {
    const name = makeToolName("my-svc", null, "post", "/items");
    assert.ok(name.startsWith("my_svc__"));
    assert.ok(name.includes("post"));
  });
});

describe("pickJsonContentType / getContentSchema", () => {
  it("returns application/json when present", () => {
    assert.equal(
      pickJsonContentType({ "application/json": { schema: {} } }),
      "application/json",
    );
  });

  it("returns first key when no application/json", () => {
    assert.equal(
      pickJsonContentType({ "text/plain": {} }),
      "text/plain",
    );
  });

  it("returns null for empty content", () => {
    assert.equal(pickJsonContentType({}), null);
  });

  it("getContentSchema extracts schema", () => {
    const result = getContentSchema({
      "application/json": { schema: { type: "object" } },
    });
    assert.equal(result.contentType, "application/json");
    assert.deepEqual(result.schema, { type: "object" });
  });
});

describe("encodeQueryValue", () => {
  it("appends string value", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "q", "hello");
    assert.equal(sp.get("q"), "hello");
  });

  it("appends array items individually", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "id", [1, 2, 3]);
    assert.deepEqual(sp.getAll("id"), ["1", "2", "3"]);
  });

  it("JSON-stringifies object values", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "filter", { x: 1 });
    assert.equal(sp.get("filter"), '{"x":1}');
  });

  it("skips null and undefined", () => {
    const sp = new URLSearchParams();
    encodeQueryValue(sp, "a", null);
    encodeQueryValue(sp, "b", undefined);
    assert.equal(sp.toString(), "");
  });
});

describe("ensureObject", () => {
  it("returns object for valid input", () => {
    const obj = { a: 1 };
    assert.equal(ensureObject(obj, "test"), obj);
  });

  it("throws for array", () => {
    assert.throws(() => ensureObject([1, 2], "test"), /must be an object/);
  });

  it("throws for string", () => {
    assert.throws(() => ensureObject("str", "test"), /must be an object/);
  });

  it("throws for null", () => {
    assert.throws(() => ensureObject(null, "test"), /must be an object/);
  });
});

describe("toAbsolutePath", () => {
  it("returns null for null/undefined/empty", () => {
    assert.equal(toAbsolutePath("/cwd", null), null);
    assert.equal(toAbsolutePath("/cwd", undefined), null);
    assert.equal(toAbsolutePath("/cwd", ""), null);
  });

  it("expands ~ to homedir", () => {
    assert.equal(toAbsolutePath("/cwd", "~"), os.homedir());
  });

  it("expands ~/path to homedir-relative", () => {
    assert.equal(
      toAbsolutePath("/cwd", "~/foo"),
      path.join(os.homedir(), "foo"),
    );
  });

  it("returns absolute path as-is", () => {
    assert.equal(toAbsolutePath("/cwd", "/absolute/path"), "/absolute/path");
  });

  it("resolves relative path against cwd", () => {
    assert.equal(
      toAbsolutePath("/some/dir", "relative/path"),
      path.resolve("/some/dir", "relative/path"),
    );
  });
});

describe("uniqueBy", () => {
  it("deduplicates by key", () => {
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

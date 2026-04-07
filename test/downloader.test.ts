import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  downloadVersionBundle,
  extractAvailableVersions,
  extractSpecFromDocument,
  extractServiceReferences,
  extractSpecFromRedocHtml,
  getOfficialDocsVersion,
} from "../src/lib/downloader.js";

void test("extractServiceReferences parses XCO API reference links from support docs HTML", () => {
  const html = `
    <a target="_blank" href="https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/tenant.html" class="c-doc-list__doc o-clip-sm">
      <h4>ExtremeCloud Orchestrator Tenant Service API Reference, 3.7.0</h4>
    </a>
    <a target="_blank" href="https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/system.html" class="c-doc-list__doc o-clip-sm">
      <h4>ExtremeCloud Orchestrator System Service API Reference, 3.7.0</h4>
    </a>
  `;

  assert.deepEqual(extractServiceReferences(html), [
    {
      title: "ExtremeCloud Orchestrator Tenant Service API Reference, 3.7.0",
      docUrl:
        "https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/tenant.html",
      fetchUrl:
        "https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/tenant.html",
      serviceSlug: "tenant",
    },
    {
      title: "ExtremeCloud Orchestrator System Service API Reference, 3.7.0",
      docUrl:
        "https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/system.html",
      fetchUrl:
        "https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.7.0%20API%20Documents/system.html",
      serviceSlug: "system",
    },
  ]);
});

void test("extractServiceReferences resolves relative instance-doc links for both fetch and public URLs", () => {
  const html = `
    <a href="/docs/auth.html">
      <span>XCO Auth Service API Reference</span>
    </a>
    <a href="/docs/tenant.html">
      <span>XCO Tenant Service API Reference</span>
    </a>
  `;

  assert.deepEqual(
    extractServiceReferences(
      html,
      "http://127.0.0.1:39000/docs/",
      "https://xco.example/docs/",
    ),
    [
      {
        title: "XCO Auth Service API Reference",
        docUrl: "https://xco.example/docs/auth.html",
        fetchUrl: "http://127.0.0.1:39000/docs/auth.html",
        serviceSlug: "xco-auth",
      },
      {
        title: "XCO Tenant Service API Reference",
        docUrl: "https://xco.example/docs/tenant.html",
        fetchUrl: "http://127.0.0.1:39000/docs/tenant.html",
        serviceSlug: "xco-tenant",
      },
    ],
  );
});

void test("extractAvailableVersions parses versions from support docs HTML", () => {
  const html = "Version 4.0.0 Version 3.8.7 Version 3.7.0 Version 3.7.0";
  assert.deepEqual(extractAvailableVersions(html), ["3.7.0", "3.8.7", "4.0.0"]);
});

void test("getOfficialDocsVersion maps patch releases to x.y.0", () => {
  assert.equal(getOfficialDocsVersion("3.8.7"), "3.8.0");
  assert.equal(getOfficialDocsVersion("3.8.0"), "3.8.0");
});

void test("extractSpecFromRedocHtml parses embedded OpenAPI JSON from API docs page", () => {
  const html = `
    <html>
      <body>
        <script>
          const __redoc_state = {"spec":{"data":{"openapi":"3.0.3","info":{"title":"Tenant Service","version":"3.7.0"},"paths":{"/health":{"get":{"operationId":"GetHealth"}}}}},"options":{}};

          var container = document.getElementById('redoc');
          Redoc.hydrate(__redoc_state, container);
        </script>
      </body>
    </html>
  `;

  assert.deepEqual(extractSpecFromRedocHtml(html), {
    openapi: "3.0.3",
    info: {
      title: "Tenant Service",
      version: "3.7.0",
    },
    paths: {
      "/health": {
        get: {
          operationId: "GetHealth",
        },
      },
    },
  });
});

void test("extractSpecFromDocument parses direct OpenAPI JSON payloads", () => {
  const text = JSON.stringify({
    openapi: "3.0.3",
    info: {
      title: "Tenant Service",
      version: "3.7.0",
    },
    paths: {
      "/tenants": {
        get: {
          operationId: "getTenants",
        },
      },
    },
  });

  assert.deepEqual(extractSpecFromDocument(text), {
    openapi: "3.0.3",
    info: {
      title: "Tenant Service",
      version: "3.7.0",
    },
    paths: {
      "/tenants": {
        get: {
          operationId: "getTenants",
        },
      },
    },
  });
});

void test("downloadVersionBundle falls back from patch release docs to the matching x.y.0 docs", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "xco-downloader-test-"),
  );
  const fallbackSupportUrl =
    "https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-3-8-0/";
  const tenantDocUrl =
    "https://documentation.extremenetworks.com/ExtremeCloud%20Orchestrator%20v3.8.0%20API%20Documents/tenant.html";

  const fetchImpl = (url: string): Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }> => {
    const bodyByUrl = new Map([
      [
        fallbackSupportUrl,
        `<html><body><a target="_blank" href="${tenantDocUrl}" class="c-doc-list__doc o-clip-sm"><h4>ExtremeCloud Orchestrator Tenant Service API Reference, 3.8.0</h4></a></body></html>`,
      ],
      [
        tenantDocUrl,
        `<html><body><script>const __redoc_state = {"spec":{"data":{"openapi":"3.0.3","info":{"title":"Tenant Service","version":"3.8.0"},"paths":{"/tenants":{"get":{"operationId":"getTenants"}}}}},"options":{}}; var container = document.getElementById('redoc');</script></body></html>`,
      ],
    ]);

    if (!bodyByUrl.has(url)) {
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text() {
        return Promise.resolve(bodyByUrl.get(url)!);
      },
    });
  };

  const manifest = await downloadVersionBundle("3.8.7", {
    xcoHome: tempRoot,
    specSource: "official",
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });

  assert.equal(manifest.version, "3.8.7");
  assert.equal(manifest.resolvedDocsVersion, "3.8.0");
  assert.equal(manifest.services.length, 1);
  assert.equal(manifest.services[0].specVersion, "3.8.0");
});

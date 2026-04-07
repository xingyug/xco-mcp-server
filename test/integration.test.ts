/**
 * Local integration test — exercises the full runtime against the mock XCO
 * server (scripts/mock-xco-server.js) running in-process.  No cluster, SSH,
 * or bastion needed.
 *
 * Flow: setup → login → tool calls → readonly verification → cleanup
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime, XcoRuntime } from "../src/lib/runtime.js";

/* ------------------------------------------------------------------ */
/*  Embedded mock XCO server (mirrors scripts/mock-xco-server.js)     */
/* ------------------------------------------------------------------ */

function buildMockXcoServer(): {
  server: http.Server;
  tenants: { id: string; name: string }[];
  requestLog: string[];
} {
  const tenants = [{ id: "1", name: "Tenant-1" }];
  const requestLog: string[] = [];

  const users = new Map([
    ["admin", { password: "secret", refreshTokens: new Set<string>() }],
  ]);

  function base64UrlEncode(v: string): string {
    return Buffer.from(v, "utf8").toString("base64url");
  }

  function createJwt(sub: string, expiresIn: number): string {
    const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = base64UrlEncode(
      JSON.stringify({
        sub,
        exp: Math.floor(Date.now() / 1000) + expiresIn,
        iat: Math.floor(Date.now() / 1000),
      }),
    );
    return `${header}.${payload}.mock`;
  }

  function issueTokens(username: string): Record<string, string> {
    const accessToken = createJwt(username, 30);
    const refreshToken = `refresh-${username}-${crypto.randomUUID()}`;
    users.get(username)?.refreshTokens.add(refreshToken);
    return {
      "access-token": accessToken,
      "refresh-token": refreshToken,
      "token-type": "Bearer",
      message: "ok",
    };
  }

  function extractBearer(req: http.IncomingMessage): string | null {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m?.[1] ?? null;
  }

  function isKnownToken(tok: string | null): boolean {
    return typeof tok === "string" && tok.split(".").length === 3;
  }

  function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => { body += c; });
      req.on("end", () => { resolve(body); });
      req.on("error", reject);
    });
  }

  const authSpec = {
    openapi: "3.0.3",
    info: { title: "Auth Service", version: "3.7.0" },
    servers: [{ url: "http://localhost/v1/auth" }],
    paths: {
      "/token/access-token": {
        post: {
          summary: "Create access token",
          operationId: "CreateAccessToken",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "OK" } },
        },
      },
      "/token/refresh": {
        post: {
          summary: "Refresh access token",
          operationId: "RefreshAccessToken",
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };

  const tenantSpec = {
    openapi: "3.0.3",
    info: { title: "Tenant Service", version: "3.7.0" },
    servers: [{ url: "http://localhost/v1/tenant" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "getHealth",
          operationId: "getHealth",
          security: [],
          responses: { "200": { description: "OK" } },
        },
      },
      "/tenants": {
        get: {
          summary: "getTenants",
          operationId: "getTenants",
          responses: { "200": { description: "OK" } },
        },
        post: {
          summary: "createTenant",
          operationId: "createTenant",
          responses: { "201": { description: "Created" } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };

  const docsIndexHtml = `<!doctype html><html><body>
    <a href="/docs/auth-service"><h1>Auth Service API Reference</h1></a>
    <a href="/docs/tenant-service"><h1>Tenant Service API Reference</h1></a>
  </body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestLog.push(`${req.method ?? "?"} ${url.pathname}`);

    if (req.method === "GET" && ["/healthz", "/v1/tenant/health"].includes(url.pathname)) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && ["/docs", "/docs/"].includes(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(docsIndexHtml);
      return;
    }
    if (req.method === "GET" && url.pathname === "/docs/auth-service") {
      sendJson(res, 200, authSpec);
      return;
    }
    if (req.method === "GET" && url.pathname === "/docs/tenant-service") {
      sendJson(res, 200, tenantSpec);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/auth/token/access-token") {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      const user = users.get(payload.username as string);
      if (!user || user.password !== payload.password) {
        sendJson(res, 401, { error: "Invalid credentials" });
        return;
      }
      sendJson(res, 200, issueTokens(payload.username as string));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/auth/token/refresh") {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      const refreshTok = payload["refresh-token"] as string | undefined;
      const username = [...users.entries()].find(([, u]) =>
        u.refreshTokens.has(refreshTok ?? ""),
      )?.[0];
      if (!username) {
        sendJson(res, 401, { error: "Invalid refresh token" });
        return;
      }
      sendJson(res, 200, issueTokens(username));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/tenant/tenants") {
      if (!isKnownToken(extractBearer(req))) {
        sendJson(res, 401, { error: "Missing or invalid bearer token" });
        return;
      }
      sendJson(res, 200, { items: tenants });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/tenant/tenants") {
      if (!isKnownToken(extractBearer(req))) {
        sendJson(res, 401, { error: "Missing or invalid bearer token" });
        return;
      }
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      const tenant = {
        id: String(tenants.length + 1),
        name: (payload.name as string | undefined) ?? `Tenant-${tenants.length + 1}`,
      };
      tenants.push(tenant);
      sendJson(res, 201, tenant);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  return { server, tenants, requestLog };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "string" ? 0 : (addr?.port ?? 0));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve(); });
  });
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                        */
/* ------------------------------------------------------------------ */

void test("integration: full local flow against mock XCO", async (t) => {
  const { server, tenants, requestLog } = buildMockXcoServer();
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const xcoHome = await fs.mkdtemp(path.join(os.tmpdir(), "xco-integ-"));

  // Patch the spec server URLs to point at our live mock
  // (The runtime's setupVersion will fetch /docs and discover specs)
  // We rely on the mock returning specs with PLACEHOLDER urls that the
  // runtime replaces via baseUrl.

  let runtime: XcoRuntime;

  t.after(async () => {
    await closeServer(server);
    await fs.rm(xcoHome, { recursive: true, force: true });
  });

  /* ---- setup version ---- */
  await t.test("setupVersion downloads specs from mock", async () => {
    runtime = await createRuntime({
      cwd: process.cwd(),
      env: {
        ...process.env,
        XCO_HOME: xcoHome,
        XCO_BASE_URL: baseUrl,
        XCO_USERNAME: "admin",
        XCO_PASSWORD: "secret",
        XCO_CONFIG: path.join(xcoHome, "config.json"),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    });

    const result = await runtime.setupVersion({
      version: "3.7.0",
      specSource: "instance",
      baseUrl,
      username: "admin",
      passwordEnv: "XCO_PASSWORD",
    });

    assert.ok(result);
    const manifest = result.manifest as Record<string, unknown>;
    assert.ok(manifest);
    const services = manifest.services as { serviceSlug: string }[];
    const slugs = services.map((s) => s.serviceSlug).sort();
    assert.deepEqual(slugs, ["auth", "tenant"]);
  });

  /* ---- list tools ---- */
  await t.test("getTools returns expected tools", () => {
    const tools = runtime.getTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("auth__createaccesstoken"), "has auth__createaccesstoken");
    assert.ok(names.includes("auth__refreshaccesstoken"), "has auth__refreshaccesstoken");
    assert.ok(names.includes("tenant__gethealth"), "has tenant__gethealth");
    assert.ok(names.includes("tenant__gettenants"), "has tenant__gettenants");
    assert.ok(names.includes("tenant__createtenant"), "has tenant__createtenant");
  });

  /* ---- login ---- */
  await t.test("xco_auth_login obtains tokens", async () => {
    const result = await runtime.callMetaTool("xco_auth_login", {}) as Record<string, unknown>;
    assert.ok(result);
    const session = result.session as Record<string, unknown>;
    assert.equal(session.cached, true);
    assert.equal(session.username, "admin");
    assert.ok(session.hasAccessToken, "has access token");
    assert.ok(session.hasRefreshToken, "has refresh token");
  });

  /* ---- call tenant health (no auth required) ---- */
  await t.test("tenant__gethealth succeeds without auth", async () => {
    const result = await runtime.callTool("tenant__gethealth", {}) as Record<string, unknown>;
    assert.ok(result);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.status, "ok");
  });

  /* ---- call tenant list (auth required, triggers token refresh) ---- */
  await t.test("tenant__gettenants returns data with auto-auth", async () => {
    const result = await runtime.callTool("tenant__gettenants", {}) as Record<string, unknown>;
    assert.ok(result);
    const body = result.body as Record<string, unknown>;
    const items = body.items as { name: string }[];
    assert.ok(items.length >= 1, "at least 1 tenant");
    assert.ok(items.some((i) => i.name === "Tenant-1"));
  });

  /* ---- create tenant ---- */
  await t.test("tenant__createtenant creates a new tenant", async () => {
    const beforeCount = tenants.length;
    const result = await runtime.callTool("tenant__createtenant", {
      body: { name: "Tenant-Integ" },
    }) as Record<string, unknown>;
    assert.ok(result);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.name, "Tenant-Integ");
    assert.equal(tenants.length, beforeCount + 1);
  });

  /* ---- verify tenant list after create ---- */
  await t.test("tenant__gettenants reflects newly created tenant", async () => {
    const result = await runtime.callTool("tenant__gettenants", {}) as Record<string, unknown>;
    const body = result.body as Record<string, unknown>;
    const items = body.items as { name: string }[];
    assert.ok(items.some((i) => i.name === "Tenant-Integ"));
  });

  /* ---- auth status ---- */
  await t.test("xco_auth_status returns cached session", async () => {
    const result = await runtime.callMetaTool("xco_auth_status", {}) as Record<string, unknown>;
    const session = result.session as Record<string, unknown>;
    assert.equal(session.cached, true);
    assert.equal(session.username, "admin");
  });

  /* ---- readonly mode ---- */
  await t.test("readonly mode hides write tools and blocks writes", async () => {
    await runtime.useVersion({ version: "3.7.0", readonly: true });

    const tools = runtime.getTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("tenant__gettenants"), "GET still exposed");
    assert.ok(names.includes("tenant__gethealth"), "health still exposed");
    assert.ok(!names.includes("tenant__createtenant"), "POST hidden");

    // read should still work
    const health = await runtime.callTool("tenant__gethealth", {}) as Record<string, unknown>;
    assert.ok(health);

    // write should be blocked
    await assert.rejects(
      runtime.callTool("tenant__createtenant", { body: { name: "Blocked" } }),
      /Readonly mode is enabled/,
    );
  });

  /* ---- raw request ---- */
  await t.test("xco_raw_request GET works", async () => {
    // Switch back to non-readonly so raw works
    await runtime.useVersion({ version: "3.7.0", readonly: false });

    const result = await runtime.callMetaTool("xco_raw_request", {
      method: "GET",
      servicePrefix: "/v1/tenant",
      path: "/health",
    }) as Record<string, unknown>;
    assert.ok(result);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.status, "ok");
  });

  /* ---- logout ---- */
  await t.test("xco_auth_logout clears session", async () => {
    const result = await runtime.callMetaTool("xco_auth_logout", {}) as Record<string, unknown>;
    assert.ok(result);
    assert.equal(result.cleared, true);
    assert.equal(result.username, "admin");
  });

  /* ---- verify mock received expected requests ---- */
  await t.test("mock server received expected HTTP calls", () => {
    assert.ok(requestLog.some((r) => r === "GET /docs" || r === "GET /docs/"), "fetched docs index");
    assert.ok(requestLog.includes("GET /docs/auth-service"), "fetched auth spec");
    assert.ok(requestLog.includes("GET /docs/tenant-service"), "fetched tenant spec");
    assert.ok(requestLog.some((r) => r === "POST /v1/auth/token/access-token"), "login call");
    assert.ok(requestLog.some((r) => r === "GET /v1/tenant/tenants"), "list tenants");
    assert.ok(requestLog.some((r) => r === "POST /v1/tenant/tenants"), "create tenant");
    assert.ok(requestLog.some((r) => r === "GET /v1/tenant/health"), "health check");
  });
});

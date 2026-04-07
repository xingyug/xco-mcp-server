import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  createMcpHttpHandler,
  PROTOCOL_VERSION,
} from "../src/mcp-http-transport.js";
import type { XcoRuntime } from "../src/lib/runtime.js";

/* ---- types for test helpers ---- */

interface TestContext {
  server: http.Server;
  baseUrl: string;
  handleMcp: ReturnType<typeof createMcpHttpHandler>;
  close: () => void;
}

interface JsonRpcBody {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown> & {
    protocolVersion?: string;
    serverInfo?: { name: string };
    capabilities?: { tools?: unknown };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

/* ---- mock runtime ---- */

function createMockRuntime(): XcoRuntime {
  return {
    getTools() {
      return [
        {
          name: "test_tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async callToolForMcp(name: string, args: Record<string, unknown>) {
      return {
        content: [{ type: "text", text: JSON.stringify({ tool: name, args }) }],
      };
    },
  } as unknown as XcoRuntime;
}

/* ---- helpers ---- */

function startServer(): Promise<TestContext> {
  const runtime = createMockRuntime();
  const handleMcp = createMcpHttpHandler(runtime);
  const server = http.createServer((req, res) => {
    handleMcp(req, res).catch((err: Error) => {
      res.writeHead(500);
      res.end(err.message);
    });
  });
  return new Promise<TestContext>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        handleMcp,
        close: () => server.close(),
      });
    });
  });
}

async function jsonPost(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function initializeSession(baseUrl: string): Promise<{ sessionId: string; body: JsonRpcBody }> {
  const res = await jsonPost(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
  const sessionId = res.headers.get("mcp-session-id")!;
  const body = (await res.json()) as JsonRpcBody;
  return { sessionId, body };
}

/* ---- tests ---- */

test("POST /mcp initialize returns protocol version and session ID", async () => {
  const ctx = await startServer();
  try {
    const { sessionId, body } = await initializeSession(ctx.baseUrl);
    assert.ok(sessionId, "should return Mcp-Session-Id header");
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.equal(body.result!.protocolVersion, PROTOCOL_VERSION);
    assert.equal(body.result!.serverInfo!.name, "xco-mcp-server");
    assert.ok(body.result!.capabilities!.tools);
  } finally {
    ctx.close();
  }
});

test("POST /mcp tools/list requires valid session", async () => {
  const ctx = await startServer();
  try {
    // Without session → 400
    const res = await jsonPost(ctx.baseUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as JsonRpcBody;
    assert.ok(body.error);

    // With valid session → 200
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res2 = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as JsonRpcBody;
    assert.ok(Array.isArray(body2.result!.tools));
    assert.equal(body2.result!.tools![0].name, "test_tool");
  } finally {
    ctx.close();
  }
});

test("POST /mcp tools/call dispatches to runtime", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "test_tool", arguments: { key: "value" } },
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonRpcBody;
    assert.equal(body.id, 4);
    const content = JSON.parse(body.result!.content![0].text) as Record<string, unknown>;
    assert.equal(content.tool, "test_tool");
    assert.deepEqual(content.args, { key: "value" });
  } finally {
    ctx.close();
  }
});

test("POST /mcp ping returns empty result", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "ping",
        params: {},
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonRpcBody;
    assert.deepEqual(body.result, {});
  } finally {
    ctx.close();
  }
});

test("POST /mcp notification returns 202", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        method: "initialized",
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res.status, 202);
  } finally {
    ctx.close();
  }
});

test("POST /mcp invalid JSON returns parse error", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as JsonRpcBody;
    assert.equal(body.error!.code, -32700);
  } finally {
    ctx.close();
  }
});

test("POST /mcp unknown method returns -32601", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "nonexistent/method",
        params: {},
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonRpcBody;
    assert.equal(body.error!.code, -32601);
  } finally {
    ctx.close();
  }
});

test("POST /mcp batch with mixed requests and notifications", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(
      ctx.baseUrl,
      [
        { jsonrpc: "2.0", id: 10, method: "ping", params: {} },
        { jsonrpc: "2.0", method: "initialized" },
        { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
      ],
      { "mcp-session-id": sessionId },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as JsonRpcBody[];
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2); // 2 requests, 1 notification
    assert.deepEqual(body[0].result, {}); // ping
    assert.ok(Array.isArray(body[1].result!.tools)); // tools/list
  } finally {
    ctx.close();
  }
});

test("POST /mcp empty batch returns 400", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await jsonPost(ctx.baseUrl, [], {
      "mcp-session-id": sessionId,
    });
    assert.equal(res.status, 400);
  } finally {
    ctx.close();
  }
});

test("DELETE /mcp terminates session", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);

    // Delete session
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(res.status, 200);

    // Subsequent request should fail
    const res2 = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 20,
        method: "ping",
        params: {},
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(res2.status, 400);
  } finally {
    ctx.close();
  }
});

test("DELETE /mcp without session returns 400", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "DELETE" });
    assert.equal(res.status, 400);
  } finally {
    ctx.close();
  }
});

test("GET /mcp without session returns 400", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "GET" });
    assert.equal(res.status, 400);
  } finally {
    ctx.close();
  }
});

test("GET /mcp with session returns 405 (no server-initiated messages)", async () => {
  const ctx = await startServer();
  try {
    const { sessionId } = await initializeSession(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(res.status, 405);
  } finally {
    ctx.close();
  }
});

test("OPTIONS /mcp returns CORS headers", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get("access-control-allow-methods")!.includes("POST"));
    assert.ok(
      res.headers
        .get("access-control-allow-headers")!
        .includes("mcp-session-id"),
    );
  } finally {
    ctx.close();
  }
});

test("PUT /mcp returns 405", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/mcp`, { method: "PUT" });
    assert.equal(res.status, 405);
  } finally {
    ctx.close();
  }
});

test("full session lifecycle: initialize → tools/list → tools/call → delete", async () => {
  const ctx = await startServer();
  try {
    // 1. Initialize
    const { sessionId, body: initBody } = await initializeSession(ctx.baseUrl);
    assert.ok(sessionId);
    assert.equal(initBody.result!.protocolVersion, PROTOCOL_VERSION);

    // 2. Send initialized notification
    const notifRes = await jsonPost(
      ctx.baseUrl,
      { jsonrpc: "2.0", method: "initialized" },
      { "mcp-session-id": sessionId },
    );
    assert.equal(notifRes.status, 202);

    // 3. List tools
    const listRes = await jsonPost(
      ctx.baseUrl,
      { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} },
      { "mcp-session-id": sessionId },
    );
    const listBody = (await listRes.json()) as JsonRpcBody;
    assert.ok(listBody.result!.tools!.length > 0);

    // 4. Call a tool
    const callRes = await jsonPost(
      ctx.baseUrl,
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "test_tool", arguments: { x: 1 } },
      },
      { "mcp-session-id": sessionId },
    );
    const callBody = (await callRes.json()) as JsonRpcBody;
    assert.ok(callBody.result!.content);

    // 5. Delete session
    const delRes = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(delRes.status, 200);

    // 6. Verify session is gone
    const afterRes = await jsonPost(
      ctx.baseUrl,
      { jsonrpc: "2.0", id: 32, method: "ping", params: {} },
      { "mcp-session-id": sessionId },
    );
    assert.equal(afterRes.status, 400);
  } finally {
    ctx.close();
  }
});

test("shared dispatch: mcp-dispatch module works with mock runtime", async () => {
  const { createMcpDispatch } = await import("../src/lib/mcp-dispatch.js");
  const runtime = createMockRuntime();
  const { dispatch } = createMcpDispatch(runtime, "test-version");

  const initResult = (await dispatch("initialize", {})) as Record<string, unknown>;
  assert.equal(initResult.protocolVersion, "test-version");

  const pingResult = await dispatch("ping", {});
  assert.deepEqual(pingResult, {});

  const toolsResult = (await dispatch("tools/list", {})) as Record<string, unknown>;
  assert.equal((toolsResult.tools as Array<{ name: string }>)[0].name, "test_tool");

  await assert.rejects(
    () => dispatch("unknown/method", {}),
    (err: unknown) => (err as { jsonRpcCode: number }).jsonRpcCode === -32601,
  );
});

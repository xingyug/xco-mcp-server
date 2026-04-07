/**
 * MCP Streamable HTTP transport handler.
 *
 * Implements the MCP 2025-03-26 Streamable HTTP specification.
 * Mount on a single endpoint (e.g., /mcp).
 *
 * Supports:
 *   POST   — JSON-RPC requests, notifications, and batches
 *   GET    — SSE stream for server-initiated messages (or 405)
 *   DELETE — session termination
 *   OPTIONS — CORS preflight
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpDispatch } from "./lib/mcp-dispatch.js";
import type { XcoRuntime } from "./lib/runtime.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-session-id",
};

interface McpSession {
  id: string;
  initialized: boolean;
}

interface BatchResult {
  response: JsonRpcResponse;
  sessionId?: string;
}

export type McpHttpHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  sessions: Map<string, McpSession>;
};

export function createMcpHttpHandler(runtime: XcoRuntime): McpHttpHandler {
  const { dispatch } = createMcpDispatch(runtime, PROTOCOL_VERSION);
  const sessions = new Map<string, McpSession>();

  /* ---- helpers ---- */

  function sendJson(
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      ...CORS_HEADERS,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendJsonRpcError(
    res: ServerResponse,
    id: string | number | null,
    code: number,
    message: string,
    statusCode = 200,
  ): void {
    sendJson(res, statusCode, {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    });
  }

  function getSession(req: IncomingMessage): McpSession | null {
    const id = req.headers["mcp-session-id"] as string | undefined;
    if (!id) return null;
    return sessions.get(id) ?? null;
  }

  async function readRequestBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += (chunk as Buffer).length;
      if (bytes > MAX_BODY_BYTES) {
        throw Object.assign(new Error("Request body too large"), {
          statusCode: 413,
        });
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function processRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await dispatch(message.method!, message.params);
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      const err = error as Error & { jsonRpcCode?: number };
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: err.jsonRpcCode ?? -32000,
          message: err.message,
        },
      };
    }
  }

  /* ---- POST ---- */

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let bodyStr: string;
    try {
      bodyStr = await readRequestBody(req);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 413) {
        res.writeHead(413, CORS_HEADERS);
        res.end();
        return;
      }
      throw error;
    }

    let message: JsonRpcRequest | JsonRpcRequest[];
    try {
      message = JSON.parse(bodyStr) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      return sendJsonRpcError(res, null, -32700, "Parse error", 400);
    }

    /* --- batch (array) --- */
    if (Array.isArray(message)) {
      return handleBatch(req, res, message);
    }

    /* --- single message --- */
    const isRequest = message.id !== undefined && message.method !== undefined;
    const isNotification =
      message.method !== undefined && message.id === undefined;

    // Client notification → 202
    if (isNotification) {
      if (message.method === "initialized") {
        const session = getSession(req);
        if (session) session.initialized = true;
      }
      res.writeHead(202, CORS_HEADERS);
      res.end();
      return;
    }

    // Client response (unusual but allowed) → 202
    if (
      !isRequest &&
      message.id !== undefined &&
      ((message as unknown as JsonRpcResponse).result !== undefined ||
       (message as unknown as JsonRpcResponse).error !== undefined)
    ) {
      res.writeHead(202, CORS_HEADERS);
      res.end();
      return;
    }

    if (!isRequest) {
      return sendJsonRpcError(res, null, -32600, "Invalid Request", 400);
    }

    // --- JSON-RPC request ---
    if (message.method === "initialize") {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { id: sessionId, initialized: false });
      const response = await processRequest(message);
      return sendJson(res, 200, response, {
        "mcp-session-id": sessionId,
      });
    }

    // All other requests require a valid session
    if (!getSession(req)) {
      return sendJsonRpcError(
        res,
        message.id ?? null,
        -32000,
        "Bad Request: missing or invalid session",
        400,
      );
    }

    const response = await processRequest(message);
    sendJson(res, 200, response);
  }

  /* --- batch --- */

  async function handleBatch(
    req: IncomingMessage,
    res: ServerResponse,
    messages: JsonRpcRequest[],
  ): Promise<void> {
    if (messages.length === 0) {
      return sendJsonRpcError(res, null, -32600, "Empty batch", 400);
    }

    const results: BatchResult[] = [];

    for (const msg of messages) {
      const isRequest = msg.id !== undefined && msg.method !== undefined;
      const isNotification = msg.method !== undefined && msg.id === undefined;

      if (isNotification) {
        if (msg.method === "initialized") {
          const session = getSession(req);
          if (session) session.initialized = true;
        }
        continue;
      }

      if (isRequest) {
        if (msg.method === "initialize") {
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { id: sessionId, initialized: false });
          const response = await processRequest(msg);
          results.push({ response, sessionId });
          continue;
        }

        if (!getSession(req)) {
          results.push({
            response: {
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32000,
                message: "Bad Request: missing or invalid session",
              },
            },
          });
          continue;
        }

        results.push({ response: await processRequest(msg) });
        continue;
      }

      // Responses or malformed — skip
    }

    if (results.length === 0) {
      res.writeHead(202, CORS_HEADERS);
      res.end();
      return;
    }

    // Extract any session ID from initialize responses
    const sessionEntry = results.find((r) => r.sessionId);
    const extraHeaders: Record<string, string> = sessionEntry
      ? { "mcp-session-id": sessionEntry.sessionId! }
      : {};

    const payload = results.map((r) => r.response);
    sendJson(res, 200, payload, extraHeaders);
  }

  /* ---- GET ---- */

  function handleGet(req: IncomingMessage, res: ServerResponse): void {
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 400, { error: "Missing or invalid session" });
    }
    res.writeHead(405, { ...CORS_HEADERS, allow: "POST, DELETE" });
    res.end();
  }

  /* ---- DELETE ---- */

  function handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 400, { error: "Missing or invalid session" });
    }
    sessions.delete(session.id);
    res.writeHead(200, CORS_HEADERS);
    res.end();
  }

  /* ---- entry point ---- */

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...CORS_HEADERS,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, accept, mcp-session-id",
      });
      res.end();
      return;
    }

    if (req.method === "POST") return handlePost(req, res);
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "DELETE") return handleDelete(req, res);

    res.writeHead(405, { ...CORS_HEADERS, allow: "GET, POST, DELETE" });
    res.end();
  }

  (handleMcp as McpHttpHandler).sessions = sessions;
  return handleMcp as McpHttpHandler;
}

export { PROTOCOL_VERSION };

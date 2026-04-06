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
import { createMcpDispatch } from "./lib/mcp-dispatch.js";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-session-id",
};

export function createMcpHttpHandler(runtime) {
  const { dispatch } = createMcpDispatch(runtime, PROTOCOL_VERSION);
  const sessions = new Map();

  /* ---- helpers ---- */

  function sendJson(res, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      ...CORS_HEADERS,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendJsonRpcError(res, id, code, message, statusCode = 200) {
    sendJson(res, statusCode, {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    });
  }

  function getSession(req) {
    const id = req.headers["mcp-session-id"];
    if (!id) return null;
    return sessions.get(id) ?? null;
  }

  async function readRequestBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        throw Object.assign(new Error("Request body too large"), {
          statusCode: 413,
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function processRequest(message) {
    try {
      const result = await dispatch(message.method, message.params);
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error.jsonRpcCode ?? -32000,
          message: error.message,
        },
      };
    }
  }

  /* ---- POST ---- */

  async function handlePost(req, res) {
    let bodyStr;
    try {
      bodyStr = await readRequestBody(req);
    } catch (error) {
      if (error.statusCode === 413) {
        res.writeHead(413, CORS_HEADERS);
        res.end();
        return;
      }
      throw error;
    }

    let message;
    try {
      message = JSON.parse(bodyStr);
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
      (message.result !== undefined || message.error !== undefined)
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
        message.id,
        -32000,
        "Bad Request: missing or invalid session",
        400,
      );
    }

    const response = await processRequest(message);
    sendJson(res, 200, response);
  }

  /* --- batch --- */

  async function handleBatch(req, res, messages) {
    if (messages.length === 0) {
      return sendJsonRpcError(res, null, -32600, "Empty batch", 400);
    }

    const results = [];

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
          // initialize in a batch is unusual but handle it
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, { id: sessionId, initialized: false });
          const response = await processRequest(msg);
          // Note: session ID cannot be per-message in a batch response.
          // The last initialize in the batch wins the header.
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
    const extraHeaders = sessionEntry
      ? { "mcp-session-id": sessionEntry.sessionId }
      : {};

    const payload = results.map((r) => r.response);
    sendJson(res, 200, payload, extraHeaders);
  }

  /* ---- GET ---- */

  function handleGet(req, res) {
    // SSE stream for server-initiated messages.
    // This server does not push server-initiated requests,
    // so GET returns 405 per spec recommendation.
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 400, { error: "Missing or invalid session" });
    }
    res.writeHead(405, { ...CORS_HEADERS, allow: "POST, DELETE" });
    res.end();
  }

  /* ---- DELETE ---- */

  function handleDelete(req, res) {
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 400, { error: "Missing or invalid session" });
    }
    sessions.delete(session.id);
    res.writeHead(200, CORS_HEADERS);
    res.end();
  }

  /* ---- entry point ---- */

  async function handleMcp(req, res) {
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

  handleMcp.sessions = sessions;
  return handleMcp;
}

export { PROTOCOL_VERSION };

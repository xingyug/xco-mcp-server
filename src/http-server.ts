#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createEventBus } from "./lib/event-bus.js";
import { parseJsonText } from "./lib/json.js";
import { createRuntime } from "./lib/runtime.js";
import { createMcpHttpHandler } from "./mcp-http-transport.js";

import type { EventListener } from "./types.js";

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large."));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const eventBus = createEventBus();
  const handleMcp = createMcpHttpHandler(runtime);
  const host = process.env.XCO_HTTP_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.XCO_HTTP_PORT ?? "8787", 10);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    // MCP Streamable HTTP transport — handles its own CORS and methods
    if (url.pathname === "/mcp") {
      return handleMcp(req, res);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        activeVersion: runtime.config.activeVersion,
        operationCount: runtime.operations.length,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/tools") {
      try {
        sendJson(res, 200, runtime.getTools());
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/bundle") {
      try {
        sendJson(res, 200, await runtime.describeBundle());
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/versions") {
      try {
        sendJson(
          res,
          200,
          await runtime.callMetaTool("xco_list_versions", {
            remote: url.searchParams.get("remote") === "1",
          }),
        );
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/events") {
      res.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": keepalive\n\n");
        }
      }, 15000);

      const unsubscribe = eventBus.subscribe((event) => {
        try {
          if (!res.writableEnded) {
            res.write(`event: ${event.type}\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      });

      res.on("error", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/auth/status") {
      sendJson(
        res,
        200,
        await runtime.callMetaTool("xco_auth_status", {
          baseUrl: url.searchParams.get("baseUrl") ?? undefined,
          username: url.searchParams.get("username") ?? undefined,
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      [
        "/v1/setup",
        "/v1/use-version",
        "/v1/call",
        "/v1/raw",
        "/v1/auth/login",
        "/v1/auth/logout",
      ].includes(url.pathname)
    ) {
      const jobId = crypto.randomUUID();

      try {
        const body = await readBody(req);
        const input = body.trim()
          ? (parseJsonText(body, "request body") as Record<string, unknown>)
          : {};
        const emit: EventListener = (event) =>
          eventBus.emit({
            jobId,
            ...event,
            type: (event as Record<string, unknown>).phase as string ?? "info",
            at: new Date().toISOString(),
          });

        emit({
          phase: "request-start",
          message: `${req.method} ${url.pathname}`,
        });

        let result: unknown;
        if (url.pathname === "/v1/setup") {
          result = await runtime.setupVersion(input, { onEvent: emit });
        } else if (url.pathname === "/v1/use-version") {
          result = await runtime.useVersion(input);
        } else if (url.pathname === "/v1/auth/login") {
          result = await runtime.callMetaTool("xco_auth_login", input, {
            onEvent: emit,
          });
        } else if (url.pathname === "/v1/auth/logout") {
          result = await runtime.callMetaTool("xco_auth_logout", input, {
            onEvent: emit,
          });
        } else if (url.pathname === "/v1/call") {
          result = await runtime.callTool(
            input.name as string,
            (input.arguments as Record<string, unknown>) ?? {},
            { onEvent: emit },
          );
        } else {
          result = await runtime.callMetaTool("xco_raw_request", input, {
            onEvent: emit,
          });
        }

        emit({
          phase: "request-complete",
          message: `${req.method} ${url.pathname} completed`,
        });
        sendJson(res, 200, { jobId, result });
      } catch (error) {
        eventBus.emit({
          jobId,
          type: "request-error",
          phase: "request-error",
          at: new Date().toISOString(),
          message: (error as Error).message,
        });
        sendJson(res, 500, { jobId, error: (error as Error).message });
      }
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
    });
  });

  server.on("error", (error: Error) => {
    process.stderr.write(`HTTP server error: ${error.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    process.stdout.write(
      `xco-http-server listening on http://${host}:${port}\n`,
    );
  });

  function shutdown(): void {
    runtime.closeTunnels();
    server.close();
  }

  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });
}

main().catch((error: unknown) => {
  const err = error as Error;
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exitCode = 1;
});

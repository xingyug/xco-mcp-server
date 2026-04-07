import { createMcpDispatch } from "./lib/mcp-dispatch.js";
import { createRuntime } from "./lib/runtime.js";

import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const PROTOCOL_VERSION = "2024-11-05";

function createJsonRpcError(code: number, message: string): { code: number; message: string } {
  return {
    code,
    message,
  };
}

function encodeMessage(payload: JsonRpcResponse): string {
  const json = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function createMessageReader(
  onMessage: (message: JsonRpcRequest) => Promise<void>,
): (chunk: Buffer | Uint8Array) => Promise<void> {
  let buffer = Buffer.alloc(0);
  let processing = false;
  const pending: Buffer[] = [];

  async function drain(): Promise<void> {
    if (processing) {
      return;
    }

    processing = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- while(true) is an intentional infinite loop
      while (true) {
        while (pending.length > 0) {
          const next = pending.shift();
          if (next) {
            buffer = Buffer.concat([buffer, next]);
          }
        }

        const separator = buffer.indexOf("\r\n\r\n");
        if (separator === -1) {
          break;
        }

        const headers = buffer.subarray(0, separator).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(headers);
        if (!match) {
          throw new Error("Missing Content-Length header.");
        }

        const contentLength = Number.parseInt(match[1], 10);
        const start = separator + 4;
        const end = start + contentLength;
        if (buffer.length < end) {
          break;
        }

        const payload = buffer.subarray(start, end).toString("utf8");
        buffer = buffer.subarray(end);
        let parsed: JsonRpcRequest;
        try {
          parsed = JSON.parse(payload) as JsonRpcRequest;
        } catch {
          throw Object.assign(new Error("Invalid JSON in message body."), {
            jsonRpcCode: -32700,
          });
        }
        await onMessage(parsed);
      }
    } finally {
      processing = false;
    }

    if (pending.length > 0) {
      await drain();
    }
  }

  return function handleChunk(chunk: Buffer | Uint8Array): Promise<void> {
    pending.push(Buffer.from(chunk));
    return drain();
  };
}

export async function runMcpServer(): Promise<void> {
  const runtime = await createRuntime();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- dispatch is a standalone function, not a method
  const { dispatch } = createMcpDispatch(runtime, PROTOCOL_VERSION);

  const read = createMessageReader(async (message) => {
    // Skip notifications (has method, no id)
    if (message.method && message.id === undefined) {
      return;
    }

    // Guard against malformed JSON-RPC messages without a method
    if (!message.method) {
      if (message.id !== undefined) {
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: createJsonRpcError(-32600, "Invalid Request: missing method"),
          }),
        );
      }
      return;
    }

    try {
      const result = await dispatch(message.method, message.params);
      process.stdout.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result,
        }),
      );
    } catch (error) {
      const err = error as Error & { jsonRpcCode?: number };
      process.stdout.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: createJsonRpcError(err.jsonRpcCode ?? -32000, err.message),
        }),
      );
    }
  });

  process.stdout.on("error", () => { /* noop */ });
  process.stdin.on("error", () => { /* noop */ });

  process.stdin.on("data", (chunk: Buffer) => {
    read(chunk).catch((error: unknown) => {
      const err = error as Error & { jsonRpcCode?: number; stack?: string };
      if (err.jsonRpcCode === -32700) {
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: null,
            error: createJsonRpcError(-32700, err.message),
          }),
        );
        return;
      }
      process.stderr.write(`${err.stack ?? err.message}\n`);
    });
  });
}

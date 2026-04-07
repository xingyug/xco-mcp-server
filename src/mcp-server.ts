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
      while (true) {
        while (pending.length > 0) {
          buffer = Buffer.concat([buffer, pending.shift()!]);
        }

        const separator = buffer.indexOf("\r\n\r\n");
        if (separator === -1) {
          break;
        }

        const headers = buffer.subarray(0, separator).toString("utf8");
        const match = headers.match(/Content-Length:\s*(\d+)/i);
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
  const { dispatch } = createMcpDispatch(runtime, PROTOCOL_VERSION);

  const read = createMessageReader(async (message) => {
    if (message.method && message.id === undefined) {
      return;
    }

    try {
      const result = await dispatch(message.method!, message.params);
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

  process.stdout.on("error", () => {});
  process.stdin.on("error", () => {});

  process.stdin.on("data", (chunk: Buffer) => {
    read(chunk).catch((error: Error & { jsonRpcCode?: number; stack?: string }) => {
      if (error.jsonRpcCode === -32700) {
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: null,
            error: createJsonRpcError(-32700, error.message),
          }),
        );
        return;
      }
      process.stderr.write(`${error.stack ?? error.message}\n`);
    });
  });
}

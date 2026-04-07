/**
 * Shared MCP dispatch logic used by both stdio and Streamable HTTP transports.
 */

import type { McpDispatch } from "../types.js";
import type { XcoRuntime } from "./runtime.js";

export function createMcpDispatch(runtime: XcoRuntime, protocolVersion: string): McpDispatch {
  async function dispatch(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "xco-mcp-server",
          version: "0.1.0",
        },
      };
    }

    if (method === "ping") {
      return {};
    }

    if (method === "tools/list") {
      return {
        tools: runtime.getTools(),
      };
    }

    if (method === "tools/call") {
      return await runtime.callToolForMcp(
        params?.name as string,
        (params?.arguments ?? {}) as Record<string, unknown>,
      );
    }

    throw Object.assign(new Error(`Unsupported method "${method}"`), {
      jsonRpcCode: -32601,
    });
  }

  return { dispatch };
}

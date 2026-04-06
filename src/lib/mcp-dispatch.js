/**
 * Shared MCP dispatch logic used by both stdio and Streamable HTTP transports.
 */

export function createMcpDispatch(runtime, protocolVersion) {
  async function dispatch(method, params) {
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
      return await runtime.callToolForMcp(params?.name, params?.arguments ?? {});
    }

    throw Object.assign(new Error(`Unsupported method "${method}"`), {
      jsonRpcCode: -32601,
    });
  }

  return { dispatch };
}

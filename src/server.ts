#!/usr/bin/env node

import { runMcpServer } from "./mcp-server.js";

runMcpServer().catch((error: unknown) => {
  const err = error as Error;
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exitCode = 1;
});

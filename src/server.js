#!/usr/bin/env node

import { runMcpServer } from "./mcp-server.js";

runMcpServer().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

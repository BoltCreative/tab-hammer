#!/usr/bin/env node
// Entry point Claude Code starts as the tab-hammer MCP server (stdio). stdout carries the MCP
// protocol, so diagnostics go to stderr only.
import { socketPath } from './paths.ts';
import { runMcpServer } from './server.ts';

runMcpServer(socketPath()).catch((err: unknown) => {
  console.error('tab-hammer MCP server failed', err);
  process.exit(1);
});

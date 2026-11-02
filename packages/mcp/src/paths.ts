import os from 'node:os';
import path from 'node:path';

/** Where the native host listens for MCP servers. TAB_HAMMER_SOCKET overrides it (tests). */
export function socketPath(): string {
  return process.env.TAB_HAMMER_SOCKET ?? path.join(os.homedir(), '.tab-hammer', 'bridge.sock');
}

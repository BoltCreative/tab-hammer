// Where the native host listens for MCP servers. Imported by the host, so node built-ins only.
import os from 'node:os';
import path from 'node:path';

/**
 * A Unix socket at ~/.tab-hammer/bridge.sock, or on Windows a named pipe per user (Windows has no
 * Unix socket files Node can use for this). TAB_HAMMER_SOCKET overrides it (tests).
 */
export function socketPath(
  platform: string = process.platform,
  home: string = os.homedir(),
  user: () => string = () => os.userInfo().username,
): string {
  if (process.env.TAB_HAMMER_SOCKET) return process.env.TAB_HAMMER_SOCKET;
  if (platform === 'win32') return `\\\\.\\pipe\\tab-hammer-${user().replace(/[^\w.-]/g, '_')}`;
  return path.join(home, '.tab-hammer', 'bridge.sock');
}

/** Whether a listen path is a Windows named pipe rather than a socket file. */
export function isPipePath(p: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(p);
}

// The service worker's connection to Tab Hammer's native host (packages/mcp), which relays calls
// from Claude's MCP server. Chrome starts the host process on connect and stops it on disconnect.
// An open native port also keeps the service worker alive, so the bridge stays reachable.
import { NATIVE_HOST_NAME, type BridgeRequest, type BridgeResponse } from '@tab-hammer/protocol';
import { runCommand } from './tabCommands';

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

let port: chrome.runtime.Port | null = null;
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Connects if not already connected. Safe to call any time (e.g. on each toolbar click). */
export function connectBridge(): void {
  if (port) return;
  clearTimeout(retryTimer);
  const p = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port = p;

  p.onMessage.addListener((req: BridgeRequest) => {
    retryMs = RETRY_MIN_MS; // the host is healthy
    void runCommand(req.method, req.params)
      .then(
        (result): BridgeResponse => ({ id: req.id, ok: true, result: result ?? null }),
        (err: unknown): BridgeResponse => ({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then((res) => {
        if (port === p) p.postMessage(res);
      });
  });

  p.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? '';
    port = null;
    // Not installed (or not allowed for this extension): the normal state without the MCP setup.
    // Don't retry; installing it and then reloading the extension or clicking the icon connects.
    if (/not found|forbidden/i.test(reason)) return;
    // The host exited (crash, or a newer host took over its socket): reconnect with backoff.
    retryTimer = setTimeout(connectBridge, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  });
}

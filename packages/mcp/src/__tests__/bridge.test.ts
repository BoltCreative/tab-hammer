// The real MCP server process (started the way Claude Code starts it) talking through the real
// native host relay to a stand-in for the extension, which answers framed requests on the relay's
// Chrome-side streams. The extension's own handling is covered by the extension's e2e suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BridgeRequest, BridgeResponse } from '@tab-hammer/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder } from '../framing.ts';
import { runNativeHost } from '../nativeHost.ts';

const MAIN = path.resolve(import.meta.dirname, '../main.ts');

let dir: string;
let sock: string;
const clients: Client[] = [];

beforeEach(() => {
  // Short path: Unix socket paths are capped near 104 bytes on macOS.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  sock = path.join(dir, 'b.sock');
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: { ...(process.env as Record<string, string>), TAB_HAMMER_SOCKET: sock },
      stderr: 'inherit',
    }),
  );
  clients.push(client);
  return client;
}

/** Starts the relay with a fake extension that answers each request via `answer`. */
async function startHost(answer: (req: BridgeRequest) => BridgeResponse | undefined) {
  const fromChrome = new PassThrough();
  const toChrome = new PassThrough();
  const decoder = new FrameDecoder();
  const seen: BridgeRequest[] = [];
  toChrome.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as BridgeRequest;
      seen.push(req);
      const res = answer(req);
      if (res) fromChrome.write(encodeFrame(res));
    }
  });
  const host = runNativeHost({ fromChrome, toChrome, socketPath: sock });
  await host.ready;
  return { host, fromChrome, seen };
}

const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as { type: string; text: string }[])[0]!.text;

describe('MCP server ↔ native host relay', () => {
  it('exposes the tab tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'close_tabs',
      'focus_tab',
      'group_tabs',
      'list_tabs',
      'move_tabs',
      'open_tabs',
      'ungroup_tabs',
      'update_group',
    ]);
  });

  it('forwards a tool call to the extension and returns its answer', async () => {
    const windows = [{ windowId: 1, focused: true, incognito: false, items: [] }];
    const { seen } = await startHost((req) => ({ id: req.id, ok: true, result: { windows } }));
    const client = await connectClient();

    const res = await client.callTool({ name: 'list_tabs', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ windows });
    expect(seen.map((r) => [r.method, r.params])).toEqual([['list_tabs', {}]]);
  });

  it('routes each answer back to the server that asked when several are connected', async () => {
    // Answer close_tabs with the count it was asked to close, so each caller can check its own.
    await startHost((req) =>
      req.method === 'close_tabs'
        ? { id: req.id, ok: true, result: { closed: req.params.tabIds.length } }
        : undefined,
    );
    const [a, b] = await Promise.all([connectClient(), connectClient()]);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: 'close_tabs', arguments: { tabIds: [1] } }),
      b.callTool({ name: 'close_tabs', arguments: { tabIds: [1, 2, 3] } }),
    ]);
    expect(JSON.parse(text(ra))).toEqual({ closed: 1 });
    expect(JSON.parse(text(rb))).toEqual({ closed: 3 });
  });

  it("reports the extension's error as a tool error", async () => {
    await startHost((req) => ({ id: req.id, ok: false, error: 'No tab with id: 99' }));
    const client = await connectClient();
    const res = await client.callTool({ name: 'focus_tab', arguments: { tabId: 99 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('No tab with id: 99');
  });

  it('says how to fix it when Tab Hammer is not running', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'list_tabs', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/isn't reachable/);
  });

  it('fails in-flight calls and removes its socket when Chrome disconnects', async () => {
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    const { host, fromChrome } = await startHost(() => {
      asked();
      return undefined; // never answer
    });
    const client = await connectClient();
    const call = client.callTool({ name: 'list_tabs', arguments: {} });
    await askedP;
    fromChrome.end();
    await host.closed;
    const res = await call;
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Tab Hammer disconnected');
    expect(fs.existsSync(sock)).toBe(false);
  });
});

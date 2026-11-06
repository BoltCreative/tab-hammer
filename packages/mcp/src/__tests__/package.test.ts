// The built package as a user runs it: `node dist/cli.js install | doctor | uninstall` in a child
// process whose HOME is a temp folder and whose PATH is empty (so no real `claude` CLI is found),
// then the MCP server from the deployed copy, which has no node_modules next to it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BridgeRequest } from '@tab-hammer/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder } from '../framing.ts';
import { runNativeHost } from '../nativeHost.ts';
import { snapshot } from './fakeEnv.ts';

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js');
let root: string;
let home: string;
let sock: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'thp-'));
  home = path.join(root, 'h');
  sock = path.join(root, 'b.sock');
  fs.mkdirSync(home);
  const chrome =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      : path.join(home, '.config', 'google-chrome');
  fs.mkdirSync(chrome, { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Only these variables, so the child can't see the real config folders.
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    env: { HOME: home, PATH: '', TAB_HAMMER_SOCKET: sock },
    encoding: 'utf8',
  });

describe.skipIf(process.platform === 'win32')('the built package', () => {
  it('installs, diagnoses, and uninstalls without a trace', () => {
    const before = snapshot(root);
    const installed = cli('install');
    expect(installed.stderr).toBe('');
    expect(installed.status).toBe(0);
    expect(installed.stdout).toMatch(/Registered the host with Google Chrome/);
    expect(installed.stdout).toMatch(/Registered with Cursor/);
    expect(installed.stdout).toMatch(/claude mcp add -s user tab-hammer --/);

    const doc = cli('doctor');
    expect(doc.status).toBe(1); // nothing connected
    expect(doc.stdout).toMatch(/✓ Google Chrome: host registered/);
    expect(doc.stdout).toMatch(/✗ Extension: not connected/);

    expect(cli('uninstall').status).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  it('rejects bad arguments', () => {
    const r = cli('install', '--only', 'netscape');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown target netscape/);
  });

  it('runs the deployed MCP server, which reaches the extension through the relay', async () => {
    expect(cli('install', '--only', 'cursor').status).toBe(0);
    const server = path.join(home, '.tab-hammer', 'mcp', 'server.js');

    const fromChrome = new PassThrough();
    const toChrome = new PassThrough();
    const decoder = new FrameDecoder();
    toChrome.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const req = msg as BridgeRequest;
        fromChrome.write(encodeFrame({ id: req.id, ok: true, result: { windows: [] } }));
      }
    });
    const host = runNativeHost({ fromChrome, toChrome, socketPath: sock });
    await host.ready;

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [server],
        env: { HOME: home, TAB_HAMMER_SOCKET: sock },
        stderr: 'inherit',
      }),
    );
    try {
      const res = await client.callTool({ name: 'list_tabs', arguments: {} });
      expect((res.content as { text: string }[])[0]!.text).toBe('{"windows":[]}');
    } finally {
      await client.close();
      fromChrome.end();
      await host.closed;
    }
  });
});

describe('publishing metadata', () => {
  const pkgDir = path.resolve(import.meta.dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(pkgDir, 'server.json'), 'utf8'));

  it('server.json names this package at its version (the MCP registry checks both)', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: pkg.version }),
    ]);
  });

  it('ships only self-contained bundles: no runtime dependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.bin['tab-hammer-mcp']).toBe('dist/cli.js');
    expect(fs.readFileSync(path.join(pkgDir, 'dist', 'cli.js'), 'utf8')).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    );
  });
});

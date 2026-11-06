// doctor against a fake machine: what it finds after an install, when pieces go missing, and
// whether a browser has Tab Hammer connected (a relay with a stand-in extension on a temp socket).
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeRequest } from '@tab-hammer/protocol';
import { doctor, formatChecks } from '../install/doctor.ts';
import { install, layout } from '../install/installer.ts';
import { encodeFrame, FrameDecoder } from '../framing.ts';
import { runNativeHost } from '../nativeHost.ts';
import { browserData, fakeClaude, fakeEnv, write, type FakeEnv } from './fakeEnv.ts';

const BUILT = path.resolve(import.meta.dirname, '../../dist');
const envs: FakeEnv[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  envs.splice(0).forEach((e) => e.cleanup());
});

function installed(): FakeEnv {
  const e = fakeEnv('linux');
  envs.push(e);
  browserData(path.join(e.xdgConfig, 'google-chrome'));
  fs.mkdirSync(path.join(e.home, '.cursor'), { recursive: true });
  fakeClaude(e);
  install(e, { builtDir: BUILT });
  return e;
}

async function relay(sock: string) {
  const fromChrome = new PassThrough();
  const toChrome = new PassThrough();
  const decoder = new FrameDecoder();
  toChrome.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as BridgeRequest;
      const windows = [{ windowId: 1, focused: true, incognito: false, items: [] }];
      fromChrome.write(encodeFrame({ id: req.id, ok: true, result: { windows } }));
    }
  });
  const host = runNativeHost({ fromChrome, toChrome, socketPath: sock });
  await host.ready;
  closers.push(async () => {
    fromChrome.end();
    await host.closed;
  });
}

const byName = (checks: Awaited<ReturnType<typeof doctor>>) =>
  Object.fromEntries(checks.map((c) => [c.name, c.ok]));

describe('doctor', () => {
  it('passes everything when installed and a browser is connected', async () => {
    const e = installed();
    const socket = path.join(e.root, 'b.sock');
    await relay(socket);
    const checks = await doctor(e, { socket });
    expect(byName(checks)).toEqual({
      Install: true,
      Node: true,
      'Google Chrome': true,
      Extension: true,
      'Claude Code': true,
      Cursor: true,
    });
    expect(formatChecks(checks)).toMatch(/Everything looks good/);
  });

  it('says the extension is not connected, and how to fix it', async () => {
    const e = installed();
    const checks = await doctor(e, { socket: path.join(e.root, 'none.sock') });
    const ext = checks.find((c) => c.name === 'Extension')!;
    expect(ext.ok).toBe(false);
    expect(ext.fix).toMatch(/toolbar icon/);
  });

  it('finds a missing host, a manifest that blocks the extension, and stale harness entries', async () => {
    const e = installed();
    const manifest = path.join(
      e.xdgConfig,
      'google-chrome',
      'NativeMessagingHosts',
      'com.boltcreative.tab_hammer.json',
    );
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ ...m, allowed_origins: [] }));
    fs.rmSync(path.join(layout(e).dir, 'server.js'));
    const checks = await doctor(e, { socket: path.join(e.root, 'none.sock') });
    const failing = Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
    expect(failing.Install).toMatch(/missing .*server\.js/);
    expect(failing['Google Chrome']).toMatch(/doesn't allow extension/);
    expect(failing.Cursor).toMatch(/server .* doesn't exist/);
    expect(formatChecks(checks)).toMatch(/To fix:\n {2}Install: Run `npx tab-hammer-mcp install`/);
  });

  it('reports a harness found but not registered, and no install', async () => {
    const e = fakeEnv('linux');
    envs.push(e);
    write(path.join(e.codexHome, 'config.toml'), 'model = "o4"\n');
    const checks = await doctor(e, { socket: path.join(e.root, 'none.sock') });
    expect(byName(checks)).toMatchObject({ Install: false, Browsers: false, Codex: false });
  });
});

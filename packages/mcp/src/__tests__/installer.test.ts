// install / uninstall end to end against a fake machine in a temp folder: real files, a fake
// registry, and a stand-in `claude` CLI. The headline property: install then uninstall leaves the
// whole home folder byte-identical, whatever browsers and harnesses were there.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_ID, NATIVE_HOST_NAME } from '@tab-hammer/protocol';
import { install, layout, loadState, uninstall } from '../install/installer.ts';
import { browserData, fakeClaude, fakeEnv, snapshot, write, type FakeEnv } from './fakeEnv.ts';

const BUILT = path.resolve(import.meta.dirname, '../../dist');
const envs: FakeEnv[] = [];
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

function machine(osName: 'darwin' | 'linux' | 'win32'): FakeEnv {
  const e = fakeEnv(osName);
  envs.push(e);
  return e;
}

const support = (e: FakeEnv, ...p: string[]) =>
  path.join(e.home, 'Library', 'Application Support', ...p);

/** A Mac with Chrome, Brave, and Arc, and every harness with some existing config of its own. */
function busyMac(): FakeEnv {
  const e = machine('darwin');
  browserData(support(e, 'Google', 'Chrome'));
  browserData(support(e, 'BraveSoftware', 'Brave-Browser'));
  browserData(support(e, 'Arc', 'User Data'));
  write(
    support(e, 'Arc', 'User Data', 'NativeMessagingHosts', 'other.host.json'),
    '{"name":"other"}',
  );
  fakeClaude(e);
  write(
    support(e, 'Claude', 'claude_desktop_config.json'),
    '{\n  "mcpServers": {\n    "fs": { "command": "x" }\n  }\n}\n',
  );
  write(path.join(e.codexHome, 'config.toml'), 'model = "o4"\n');
  fs.mkdirSync(path.join(e.home, '.cursor')); // installed, no mcp.json yet
  write(
    support(e, 'Code', 'User', 'mcp.json'),
    '{\n\t// mine\n\t"servers": {},\n\t"inputs": []\n}',
  );
  write(path.join(e.home, '.codeium', 'windsurf', 'mcp_config.json'), '{}');
  return e;
}

const opts = { builtDir: BUILT };

describe('install', () => {
  it('registers the host with each browser found and the server with each harness found', () => {
    const e = busyMac();
    const report = install(e, opts);
    expect(report.done.sort()).toEqual(
      [
        'arc',
        'brave',
        'chrome',
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'vscode',
        'windsurf',
      ].sort(),
    );
    expect(report.failed).toEqual([]);

    const L = layout(e);
    const server = path.join(L.dir, 'server.js');
    const launcher = path.join(L.dir, 'tab-hammer-host');
    expect(fs.readFileSync(launcher, 'utf8')).toBe(
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(L.dir, 'host.js')}" "$@"\n`,
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        support(e, 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
        'utf8',
      ),
    );
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    expect(
      fs.existsSync(
        support(e, 'Arc', 'User Data', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      ),
    ).toBe(true);

    expect(e.calls).toContainEqual([
      'claude',
      'mcp',
      'add',
      '-s',
      'user',
      'tab-hammer',
      '--',
      process.execPath,
      server,
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(e.home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { 'tab-hammer': { type: 'stdio', command: process.execPath, args: [server] } },
    });
    expect(fs.readFileSync(path.join(e.codexHome, 'config.toml'), 'utf8')).toBe(
      `model = "o4"\n\n[mcp_servers.tab-hammer]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\n`,
    );
  });

  it('leaves alone browsers and harnesses that are not there', () => {
    const e = machine('linux');
    browserData(path.join(e.xdgConfig, 'chromium'));
    const report = install(e, opts);
    expect(report.done).toEqual(['chromium']);
    expect(fs.existsSync(path.join(e.xdgConfig, 'google-chrome'))).toBe(false);
    expect(fs.existsSync(path.join(e.home, '.cursor'))).toBe(false);
    expect(report.skipped).toContain('claude-code');
  });

  it('--only and --skip pick targets, and an unknown name is an error', () => {
    const e = busyMac();
    expect(install(e, { ...opts, only: ['chrome', 'cursor'] }).done).toEqual(['chrome', 'cursor']);
    const e2 = busyMac();
    const skipped = install(e2, { ...opts, skip: ['claude-code', 'arc'] }).done;
    expect(skipped).not.toContain('claude-code');
    expect(skipped).not.toContain('arc');
    expect(skipped).toContain('codex');
    expect(() => install(e2, { ...opts, only: ['netscape'] })).toThrow(/Unknown target netscape/);
  });

  it('allows extra extension IDs in every manifest', () => {
    const e = machine('linux');
    browserData(path.join(e.xdgConfig, 'google-chrome'));
    const store = 'abcdefghijklmnopabcdefghijklmnop';
    install(e, { ...opts, extensionIds: [store] });
    const m = JSON.parse(
      fs.readFileSync(
        path.join(e.xdgConfig, 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
        'utf8',
      ),
    );
    expect(m.allowed_origins).toEqual([
      `chrome-extension://${EXTENSION_ID}/`,
      `chrome-extension://${store}/`,
    ]);
  });

  it('keeps going when one harness config is broken, and says which', () => {
    const e = machine('linux');
    write(path.join(e.home, '.cursor', 'mcp.json'), '[not an object]');
    fs.mkdirSync(e.codexHome);
    const lines: string[] = [];
    const report = install(e, { ...opts, log: (l) => lines.push(l) });
    expect(report.failed).toEqual(['cursor']);
    expect(report.done).toContain('codex');
    expect(lines.join('\n')).toMatch(
      /Couldn't register with Cursor: the file is not a JSON object/,
    );
    expect(fs.readFileSync(path.join(e.home, '.cursor', 'mcp.json'), 'utf8')).toBe(
      '[not an object]',
    );
  });
});

describe('install then uninstall', () => {
  it('leaves a busy Mac byte-identical', () => {
    const e = busyMac();
    const before = snapshot(e.root);
    install(e, opts);
    expect(snapshot(e.root)).not.toEqual(before);
    const report = uninstall(e);
    expect(report.failed).toEqual([]);
    expect(snapshot(e.root)).toEqual(before);
  });

  it('leaves a Linux machine byte-identical, including folders install had to create', () => {
    const e = machine('linux');
    browserData(path.join(e.xdgConfig, 'google-chrome'));
    browserData(path.join(e.xdgConfig, 'BraveSoftware', 'Brave-Browser'));
    fs.mkdirSync(path.join(e.xdgConfig, 'Claude'), { recursive: true });
    fs.mkdirSync(path.join(e.xdgConfig, 'devin'), { recursive: true });
    const before = snapshot(e.root);
    install(e, opts);
    uninstall(e);
    expect(snapshot(e.root)).toEqual(before);
  });

  it('survives installing twice', () => {
    const e = busyMac();
    const before = snapshot(e.root);
    install(e, opts);
    const once = snapshot(e.root);
    install(e, opts);
    expect(snapshot(e.root)).toEqual(once);
    uninstall(e);
    expect(snapshot(e.root)).toEqual(before);
  });

  it('removes our entries but keeps what the user added since', () => {
    const e = busyMac();
    install(e, opts);
    const cursor = path.join(e.home, '.cursor', 'mcp.json');
    const withMine = fs
      .readFileSync(cursor, 'utf8')
      .replace('"mcpServers": {', '"mcpServers": {\n    "mine": {},');
    fs.writeFileSync(cursor, withMine);
    uninstall(e);
    expect(JSON.parse(fs.readFileSync(cursor, 'utf8'))).toEqual({ mcpServers: { mine: {} } });
  });

  it('uninstall --only undoes just those, and a later full uninstall the rest', () => {
    const e = busyMac();
    const before = snapshot(e.root);
    install(e, opts);
    uninstall(e, { only: ['cursor', 'brave'] });
    expect(fs.existsSync(path.join(e.home, '.cursor', 'mcp.json'))).toBe(false);
    // Brave reads Chrome's folder on macOS, and Chrome is still installed: the manifest stays.
    expect(
      fs.existsSync(
        support(e, 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      ),
    ).toBe(true);
    expect(Object.keys(loadState(e)!.harnesses)).not.toContain('cursor');
    uninstall(e);
    expect(snapshot(e.root)).toEqual(before);
  });
});

describe('Windows (simulated: posix temp paths, fake registry)', () => {
  function windows(): FakeEnv {
    const e = machine('win32');
    browserData(path.join(e.localAppData, 'Google', 'Chrome', 'User Data'));
    browserData(path.join(e.localAppData, 'Google', 'Chrome SxS', 'User Data'));
    browserData(path.join(e.localAppData, 'Microsoft', 'Edge', 'User Data'));
    fs.mkdirSync(path.join(e.localAppData, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4'), {
      recursive: true,
    });
    write(path.join(e.appData, 'Claude', 'claude_desktop_config.json'), '{}\r\n');
    // Chrome makes its own key when installed; Edge's NativeMessagingHosts key already exists.
    for (const k of ['Google', 'Google\\Chrome', 'Microsoft', 'Microsoft\\Edge']) {
      e.regKeys.add(`Software\\${k}`);
    }
    e.regKeys.add('Software\\Microsoft\\Edge\\NativeMessagingHosts');
    return e;
  }

  const chromeKey = `Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  const edgeKey = `Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

  it('writes one manifest, points each browser family’s HKCU key at it, and a .bat launcher', () => {
    const e = windows();
    const report = install(e, opts);
    expect(report.done).toEqual(
      expect.arrayContaining(['chrome', 'chrome-canary', 'edge', 'arc', 'claude-desktop']),
    );
    const L = layout(e);
    expect([...e.reg.entries()].sort()).toEqual([
      [chromeKey, L.winManifest],
      [edgeKey, L.winManifest],
    ]);
    const m = JSON.parse(fs.readFileSync(L.winManifest, 'utf8'));
    expect(m.path).toBe(path.join(L.dir, 'tab-hammer-host.bat'));
    expect(fs.readFileSync(m.path, 'utf8')).toBe(
      `@echo off\r\n"${process.execPath}" "%~dp0host.js" %*\r\n`,
    );
    // CRLF files get CRLF entries.
    expect(
      fs.readFileSync(path.join(e.appData, 'Claude', 'claude_desktop_config.json'), 'utf8'),
    ).toMatch(/\r\n {4}"tab-hammer"/);
  });

  it('uninstall deletes the keys and files, and restores a key value it replaced', () => {
    const e = windows();
    e.registry.set(edgeKey, 'C:\\old\\manifest.json');
    const before = snapshot(e.root);
    const keysBefore = [...e.regKeys].sort();
    install(e, opts);
    expect(e.regKeys.has('Software\\Google\\Chrome\\NativeMessagingHosts')).toBe(true);
    uninstall(e);
    expect([...e.reg.entries()]).toEqual([[edgeKey, 'C:\\old\\manifest.json']]);
    // The NativeMessagingHosts key install created under Chrome's is gone again.
    expect([...e.regKeys].sort()).toEqual(keysBefore);
    expect(snapshot(e.root)).toEqual(before);
  });

  it('a shared key stays while a browser using it stays installed', () => {
    const e = windows();
    install(e, opts);
    uninstall(e, { only: ['chrome-canary'] });
    expect(e.reg.has(chromeKey)).toBe(true);
    uninstall(e, { only: ['chrome', 'arc'] });
    expect(e.reg.has(chromeKey)).toBe(false);
  });
});

describe('uninstall with no install state (the old repo installer)', () => {
  it('removes our manifests and entries wherever they are', () => {
    const e = machine('darwin');
    const hosts = support(e, 'Google', 'Chrome', 'NativeMessagingHosts');
    write(path.join(hosts, `${NATIVE_HOST_NAME}.json`), '{}');
    write(path.join(hosts, 'other.json'), '{}');
    write(path.join(e.home, '.tab-hammer', 'native-host', 'host.ts'), '');
    const claude = fakeClaude(e);
    claude.set('tab-hammer', ['node', 'main.ts']);
    uninstall(e);
    expect(fs.readdirSync(hosts)).toEqual(['other.json']);
    expect(fs.existsSync(path.join(e.home, '.tab-hammer', 'native-host'))).toBe(false);
    expect(claude.has('tab-hammer')).toBe(false);
  });
});

describe('review regressions', () => {
  it('a Brave-only Mac does not start counting Chrome as installed', () => {
    const e = machine('darwin');
    browserData(support(e, 'BraveSoftware', 'Brave-Browser'));
    expect(install(e, opts).done).toEqual(['brave']);
    // Chrome's folder now exists (Brave reads its manifest from there), but Chrome isn't installed.
    expect(install(e, opts).done).toEqual(['brave']);
  });

  it('no false "no browser" message when --only leaves browsers out', () => {
    const e = busyMac();
    const lines: string[] = [];
    install(e, { ...opts, only: ['cursor'], log: (l) => lines.push(l) });
    expect(lines.join('\n')).not.toMatch(/No supported browser/);
  });

  it('keeps the old repo host while a manifest still points at it', () => {
    const e = machine('linux');
    const chrome = path.join(e.xdgConfig, 'google-chrome');
    browserData(chrome);
    const legacy = path.join(e.home, '.tab-hammer', 'native-host');
    write(path.join(legacy, 'tab-hammer-host'), '#!/bin/sh\n');
    write(
      path.join(chrome, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      JSON.stringify({ path: path.join(legacy, 'tab-hammer-host') }),
    );
    fs.mkdirSync(path.join(e.home, '.cursor'));
    install(e, { ...opts, only: ['cursor'] });
    expect(fs.existsSync(legacy)).toBe(true);
    install(e, opts); // now Chrome's manifest points at the new host
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('takes over old Tab Hammer manifests in folders of browsers that never ran', () => {
    // The old installer wrote one wherever the folder existed (other apps create these folders).
    const e = machine('darwin');
    browserData(support(e, 'Google', 'Chrome'));
    const legacy = path.join(e.home, '.tab-hammer', 'native-host');
    write(path.join(legacy, 'tab-hammer-host'), '#!/bin/sh\n');
    const stale = support(e, 'Google', 'Chrome Beta', 'NativeMessagingHosts');
    write(path.join(stale, 'com.1password.json'), '{}');
    write(
      path.join(stale, `${NATIVE_HOST_NAME}.json`),
      JSON.stringify({ name: NATIVE_HOST_NAME, path: path.join(legacy, 'tab-hammer-host') }),
    );
    expect(install(e, opts).done).toContain('chrome-beta');
    const m = JSON.parse(fs.readFileSync(path.join(stale, `${NATIVE_HOST_NAME}.json`), 'utf8'));
    expect(m.path).toBe(path.join(layout(e).dir, 'tab-hammer-host'));
    expect(fs.existsSync(legacy)).toBe(false);
    uninstall(e);
    expect(fs.readdirSync(stale)).toEqual(['com.1password.json']);
  });

  it('a Codex setting the user added under our table leaves with it, not into another table', () => {
    const e = machine('linux');
    const toml = path.join(e.codexHome, 'config.toml');
    const original = '[mcp_servers.github]\ncommand = "gh"\n';
    write(toml, original);
    install(e, opts);
    fs.appendFileSync(toml, 'startup_timeout_sec = 60\n\n[mcp_servers.tab-hammer.env]\nX = "1"\n');
    uninstall(e);
    expect(fs.readFileSync(toml, 'utf8')).toBe(original);
  });

  it('re-installing after the harness reformatted its config still cleans up fully', () => {
    const e = machine('linux');
    fs.mkdirSync(path.join(e.home, '.cursor'));
    const before = snapshot(e.root);
    install(e, opts);
    const file = path.join(e.home, '.cursor', 'mcp.json');
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))));
    install(e, opts);
    uninstall(e);
    expect(snapshot(e.root)).toEqual(before);
  });
});

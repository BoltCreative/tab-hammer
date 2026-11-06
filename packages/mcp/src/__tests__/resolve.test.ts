// Where each browser's host registration and each harness's config live, per OS. Real-looking
// paths for each OS (path.win32 for Windows), resolved without touching the disk.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSERS, resolveBrowser } from '../install/browsers.ts';
import { parseRegQueryDefault, winQuote, type InstallEnv, type OsName } from '../install/env.ts';
import { HARNESSES } from '../install/harnesses.ts';
import { layout } from '../install/installer.ts';
import { isPipePath, socketPath } from '../paths.ts';

function env(osName: OsName): InstallEnv {
  const win = osName === 'win32';
  const home = win ? 'C:\\Users\\ada' : osName === 'darwin' ? '/Users/ada' : '/home/ada';
  const p = win ? path.win32 : path.posix;
  return {
    os: osName,
    path: p,
    home,
    appData: p.join(home, 'AppData', 'Roaming'),
    localAppData: p.join(home, 'AppData', 'Local'),
    xdgConfig: p.join(home, '.config'),
    codexHome: p.join(home, '.codex'),
    nodePath: win ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node',
    user: 'ada',
    registry: { get: () => undefined, set: () => {}, delete: () => {} },
    runner: { has: () => false, run: () => ({ status: 1, stdout: '', stderr: '' }) },
  };
}

function where(osName: OsName) {
  const e = env(osName);
  return Object.fromEntries(
    BROWSERS.flatMap((b) => {
      const t = resolveBrowser(e, b);
      if (!t) return [];
      return [[b.id, t.kind === 'file' ? t.manifestPath : `HKCU\\${t.key} (${t.dataDir})`]];
    }),
  );
}

const HOST = 'com.boltcreative.tab_hammer';

describe('browser host registration paths', () => {
  it('macOS: a manifest in each browser’s NativeMessagingHosts (Brave reads Chrome’s)', () => {
    const s = '/Users/ada/Library/Application Support';
    expect(where('darwin')).toEqual({
      chrome: `${s}/Google/Chrome/NativeMessagingHosts/${HOST}.json`,
      'chrome-beta': `${s}/Google/Chrome Beta/NativeMessagingHosts/${HOST}.json`,
      'chrome-dev': `${s}/Google/Chrome Dev/NativeMessagingHosts/${HOST}.json`,
      'chrome-canary': `${s}/Google/Chrome Canary/NativeMessagingHosts/${HOST}.json`,
      chromium: `${s}/Chromium/NativeMessagingHosts/${HOST}.json`,
      brave: `${s}/Google/Chrome/NativeMessagingHosts/${HOST}.json`,
      'brave-beta': `${s}/Google/Chrome/NativeMessagingHosts/${HOST}.json`,
      'brave-nightly': `${s}/Google/Chrome/NativeMessagingHosts/${HOST}.json`,
      edge: `${s}/Microsoft Edge/NativeMessagingHosts/${HOST}.json`,
      'edge-beta': `${s}/Microsoft Edge Beta/NativeMessagingHosts/${HOST}.json`,
      'edge-dev': `${s}/Microsoft Edge Dev/NativeMessagingHosts/${HOST}.json`,
      'edge-canary': `${s}/Microsoft Edge Canary/NativeMessagingHosts/${HOST}.json`,
      arc: `${s}/Arc/User Data/NativeMessagingHosts/${HOST}.json`,
    });
  });

  it('Linux: a manifest under ~/.config per browser (no Arc, no Edge Canary)', () => {
    const c = '/home/ada/.config';
    expect(where('linux')).toEqual({
      chrome: `${c}/google-chrome/NativeMessagingHosts/${HOST}.json`,
      'chrome-beta': `${c}/google-chrome-beta/NativeMessagingHosts/${HOST}.json`,
      'chrome-dev': `${c}/google-chrome-unstable/NativeMessagingHosts/${HOST}.json`,
      'chrome-canary': `${c}/google-chrome-canary/NativeMessagingHosts/${HOST}.json`,
      chromium: `${c}/chromium/NativeMessagingHosts/${HOST}.json`,
      brave: `${c}/BraveSoftware/Brave-Browser/NativeMessagingHosts/${HOST}.json`,
      'brave-beta': `${c}/BraveSoftware/Brave-Browser-Beta/NativeMessagingHosts/${HOST}.json`,
      'brave-nightly': `${c}/BraveSoftware/Brave-Browser-Nightly/NativeMessagingHosts/${HOST}.json`,
      edge: `${c}/microsoft-edge/NativeMessagingHosts/${HOST}.json`,
      'edge-beta': `${c}/microsoft-edge-beta/NativeMessagingHosts/${HOST}.json`,
      'edge-dev': `${c}/microsoft-edge-dev/NativeMessagingHosts/${HOST}.json`,
    });
  });

  it('Windows: an HKCU key per browser family, detected by its User Data folder', () => {
    const l = 'C:\\Users\\ada\\AppData\\Local';
    const chrome = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`;
    const chromium = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST}`;
    const edge = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`;
    expect(where('win32')).toEqual({
      chrome: `${chrome} (${l}\\Google\\Chrome\\User Data)`,
      'chrome-beta': `${chrome} (${l}\\Google\\Chrome Beta\\User Data)`,
      'chrome-dev': `${chrome} (${l}\\Google\\Chrome Dev\\User Data)`,
      'chrome-canary': `${chrome} (${l}\\Google\\Chrome SxS\\User Data)`,
      chromium: `${chromium} (${l}\\Chromium\\User Data)`,
      brave: `${chromium} (${l}\\BraveSoftware\\Brave-Browser\\User Data)`,
      'brave-beta': `${chromium} (${l}\\BraveSoftware\\Brave-Browser-Beta\\User Data)`,
      'brave-nightly': `${chromium} (${l}\\BraveSoftware\\Brave-Browser-Nightly\\User Data)`,
      edge: `${edge} (${l}\\Microsoft\\Edge\\User Data)`,
      'edge-beta': `${edge} (${l}\\Microsoft\\Edge Beta\\User Data)`,
      'edge-dev': `${edge} (${l}\\Microsoft\\Edge Dev\\User Data)`,
      'edge-canary': `${edge} (${l}\\Microsoft\\Edge SxS\\User Data)`,
      arc: `${chrome} (${l}\\Packages\\TheBrowserCompany.Arc)`,
    });
  });
});

describe('harness config locations', () => {
  const files = (osName: OsName) => {
    const e = env(osName);
    return Object.fromEntries(
      HARNESSES.map((h) => [h.id, h.kind === 'cli' ? h.command : h.file(e)]),
    );
  };

  it('macOS', () => {
    const s = '/Users/ada/Library/Application Support';
    expect(files('darwin')).toEqual({
      'claude-code': 'claude',
      'claude-desktop': `${s}/Claude/claude_desktop_config.json`,
      codex: '/Users/ada/.codex/config.toml',
      cursor: '/Users/ada/.cursor/mcp.json',
      vscode: `${s}/Code/User/mcp.json`,
      'vscode-insiders': `${s}/Code - Insiders/User/mcp.json`,
      windsurf: '/Users/ada/.codeium/windsurf/mcp_config.json',
      'devin-desktop': '/Users/ada/.config/devin/mcp_config.json',
    });
  });

  it('Linux', () => {
    expect(files('linux')).toEqual({
      'claude-code': 'claude',
      'claude-desktop': '/home/ada/.config/Claude/claude_desktop_config.json',
      codex: '/home/ada/.codex/config.toml',
      cursor: '/home/ada/.cursor/mcp.json',
      vscode: '/home/ada/.config/Code/User/mcp.json',
      'vscode-insiders': '/home/ada/.config/Code - Insiders/User/mcp.json',
      windsurf: '/home/ada/.codeium/windsurf/mcp_config.json',
      'devin-desktop': '/home/ada/.config/devin/mcp_config.json',
    });
  });

  it('Windows', () => {
    const r = 'C:\\Users\\ada\\AppData\\Roaming';
    expect(files('win32')).toEqual({
      'claude-code': 'claude',
      'claude-desktop': `${r}\\Claude\\claude_desktop_config.json`,
      codex: 'C:\\Users\\ada\\.codex\\config.toml',
      cursor: 'C:\\Users\\ada\\.cursor\\mcp.json',
      vscode: `${r}\\Code\\User\\mcp.json`,
      'vscode-insiders': `${r}\\Code - Insiders\\User\\mcp.json`,
      windsurf: 'C:\\Users\\ada\\.codeium\\windsurf\\mcp_config.json',
      'devin-desktop': `${r}\\devin\\mcp_config.json`,
    });
  });
});

describe('install folder and bridge socket', () => {
  it('keeps files outside ~/Documents: ~/.tab-hammer, or %LOCALAPPDATA% on Windows', () => {
    expect(layout(env('darwin')).dir).toBe('/Users/ada/.tab-hammer/mcp');
    expect(layout(env('linux')).dir).toBe('/home/ada/.tab-hammer/mcp');
    expect(layout(env('win32')).dir).toBe('C:\\Users\\ada\\AppData\\Local\\TabHammer\\mcp');
  });

  it('uses a Unix socket, or a per-user named pipe on Windows', () => {
    const saved = process.env.TAB_HAMMER_SOCKET;
    delete process.env.TAB_HAMMER_SOCKET;
    try {
      expect(socketPath('darwin', '/Users/ada')).toBe('/Users/ada/.tab-hammer/bridge.sock');
      const pipe = socketPath('win32', 'C:\\Users\\ada', () => 'Ada Lovelace');
      expect(pipe).toBe('\\\\.\\pipe\\tab-hammer-Ada_Lovelace');
      expect(isPipePath(pipe)).toBe(true);
      expect(isPipePath('/Users/ada/.tab-hammer/bridge.sock')).toBe(false);
    } finally {
      if (saved !== undefined) process.env.TAB_HAMMER_SOCKET = saved;
    }
  });
});

describe('Windows helpers', () => {
  it('reads the default value from `reg query /ve` output', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\x\r\n' +
      '    (Default)    REG_SZ    C:\\Users\\ada\\AppData\\Local\\TabHammer\\mcp\\x.json\r\n\r\n';
    expect(parseRegQueryDefault(out)).toBe(
      'C:\\Users\\ada\\AppData\\Local\\TabHammer\\mcp\\x.json',
    );
    expect(parseRegQueryDefault('\r\nHKEY_CURRENT_USER\\Software\\x\r\n')).toBeUndefined();
  });

  it('quotes shell arguments that need it', () => {
    expect(winQuote('mcp')).toBe('mcp');
    expect(winQuote('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
  });
});

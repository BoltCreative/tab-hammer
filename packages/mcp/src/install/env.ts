// Everything the installer learns from the machine it runs on, gathered in one place so tests can
// hand it a fake one: the OS, the folders that stand in for home and AppData, the Windows registry,
// and running other programs (the `claude` CLI). Files are read and written with the real `fs`,
// so tests point the folders at a temp directory.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OsName = 'darwin' | 'linux' | 'win32';

/** HKCU registry access, as much as the installer needs (default values of keys under HKCU). */
export interface Registry {
  /** The key's default value, or undefined if the key doesn't exist. */
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  /** Deletes the key and everything under it. */
  delete(key: string): void;
  exists(key: string): boolean;
  /** Whether the key has no values and no subkeys (unknown counts as not empty). */
  isEmpty(key: string): boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** Whether `cmd` is a program on PATH. */
  has(cmd: string): boolean;
  run(cmd: string, args: string[]): RunResult;
}

export interface InstallEnv {
  os: OsName;
  /** Path functions for that OS's paths (path.win32 on Windows). */
  path: typeof path.posix;
  home: string;
  /** %APPDATA% (Roaming) on Windows. */
  appData: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppData: string;
  /** $XDG_CONFIG_HOME, or ~/.config. */
  xdgConfig: string;
  /** $CODEX_HOME, or ~/.codex. */
  codexHome: string;
  /** The node binary Chrome and the harnesses will run the host and server with. */
  nodePath: string;
  /** Windows user name, for the per-user named pipe. */
  user: string;
  registry: Registry;
  runner: Runner;
}

/** The real machine. */
export function realEnv(): InstallEnv {
  const osName = (['darwin', 'linux', 'win32'] as const).find((o) => o === process.platform);
  if (!osName) throw new Error(`Unsupported platform: ${process.platform}`);
  const p = osName === 'win32' ? path.win32 : path.posix;
  const home = os.homedir();
  const e = process.env;
  return {
    os: osName,
    path: p,
    home,
    appData: e.APPDATA ?? p.join(home, 'AppData', 'Roaming'),
    localAppData: e.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'),
    xdgConfig: e.XDG_CONFIG_HOME || p.join(home, '.config'),
    codexHome: e.CODEX_HOME || p.join(home, '.codex'),
    nodePath: process.execPath,
    user: os.userInfo().username,
    registry: osName === 'win32' ? regExeRegistry() : noRegistry,
    runner: realRunner(osName),
  };
}

const noRegistry: Registry = {
  get: () => undefined,
  exists: () => false,
  isEmpty: () => false,
  set: () => {
    throw new Error('no registry on this platform');
  },
  delete: () => {},
};

/** The registry through `reg.exe`, which ships with every Windows. */
export function regExeRegistry(run = spawnSync): Registry {
  const reg = (args: string[]) => run('reg', args, { encoding: 'utf8', windowsHide: true });
  return {
    get(key) {
      const r = reg(['query', `HKCU\\${key}`, '/ve']);
      if (r.status !== 0) return undefined;
      return parseRegQueryDefault(String(r.stdout));
    },
    set(key, value) {
      const r = reg(['add', `HKCU\\${key}`, '/ve', '/t', 'REG_SZ', '/d', value, '/f']);
      if (r.status !== 0) throw new Error(`reg add failed: ${String(r.stderr).trim()}`);
    },
    delete(key) {
      reg(['delete', `HKCU\\${key}`, '/f']);
    },
    exists(key) {
      return reg(['query', `HKCU\\${key}`]).status === 0;
    },
    isEmpty(key) {
      const r = reg(['query', `HKCU\\${key}`]);
      return r.status === 0 && regQueryIsEmpty(String(r.stdout));
    },
  };
}

/** The default value from `reg query <key> /ve` output ("(Default)    REG_SZ    <value>"). */
export function parseRegQueryDefault(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s{2,}(.*)$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/** `reg query <key>` prints the key's own path, then a line per value and subkey. */
export function regQueryIsEmpty(stdout: string): boolean {
  return stdout.split(/\r?\n/).filter((l) => l.trim()).length <= 1;
}

function realRunner(osName: OsName): Runner {
  const win = osName === 'win32';
  return {
    has(cmd) {
      const r = spawnSync(win ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
      return r.status === 0;
    },
    run(cmd, args) {
      // On Windows `claude` is a .cmd shim, which only runs through the shell, so quote each arg.
      const r = win
        ? spawnSync([cmd, ...args].map(winQuote).join(' '), {
            shell: true,
            encoding: 'utf8',
            windowsHide: true,
          })
        : spawnSync(cmd, args, { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

export function winQuote(arg: string): string {
  return /^[\w\-./:\\=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** Whether a folder exists (helper for detection). */
export const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

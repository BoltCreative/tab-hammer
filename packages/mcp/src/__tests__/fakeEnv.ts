// A fake machine for installer tests: every folder lives under a temp dir, the registry is a Map,
// and other programs (the `claude` CLI) are a recorded stub. Nothing here touches the real home
// folder, browser profiles, registry, or harness configs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstallEnv, OsName, RunResult } from '../install/env.ts';

export interface FakeEnv extends InstallEnv {
  root: string;
  reg: Map<string, string>;
  calls: string[][];
  /** Programs the fake PATH has, and what running them returns. */
  programs: Map<string, (args: string[]) => RunResult>;
  cleanup(): void;
}

/**
 * Windows is simulated with posix paths under the temp dir (so the real fs works), plus the
 * registry stub; path *resolution* for real Windows paths is tested separately with path.win32.
 */
export function fakeEnv(osName: OsName): FakeEnv {
  // Short base: the doctor test listens on a Unix socket in here (paths capped near 104 bytes).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thi-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const reg = new Map<string, string>();
  const calls: string[][] = [];
  const programs = new Map<string, (args: string[]) => RunResult>();
  return {
    root,
    reg,
    calls,
    programs,
    os: osName,
    path: path.posix,
    home,
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    xdgConfig: path.join(home, '.config'),
    codexHome: path.join(home, '.codex'),
    nodePath: process.execPath,
    user: 'tester',
    registry: {
      get: (k) => reg.get(k),
      set: (k, v) => void reg.set(k, v),
      delete: (k) => void reg.delete(k),
    },
    runner: {
      has: (cmd) => programs.has(cmd),
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        const p = programs.get(cmd);
        return p ? p(args) : { status: null, stdout: '', stderr: 'not found' };
      },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Every file and folder under `dir`, with file contents, for byte-for-byte comparisons. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) {
        out[rel + '/'] = '';
        walk(p);
      } else {
        out[rel] = fs.readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A stand-in `claude` CLI that keeps user-scope servers in memory, like `claude mcp`. */
export function fakeClaude(env: FakeEnv): Map<string, string[]> {
  const servers = new Map<string, string[]>();
  env.programs.set('claude', (args) => {
    const [, sub] = args;
    const name = sub === 'get' ? args[2]! : args[4]!;
    if (sub === 'add') {
      if (servers.has(name)) return { status: 1, stdout: '', stderr: 'already exists' };
      servers.set(name, args.slice(args.indexOf('--') + 1));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (sub === 'remove') {
      const had = servers.delete(name);
      return { status: had ? 0 : 1, stdout: '', stderr: had ? '' : 'not found' };
    }
    if (sub === 'get') {
      const s = servers.get(name);
      return s
        ? { status: 0, stdout: `${name}:\n  Command: ${s.join(' ')}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'not found' };
    }
    return { status: 1, stdout: '', stderr: 'unknown' };
  });
  return servers;
}

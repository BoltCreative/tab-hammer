import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import type * as Deploy from '../../mcp/src/deploy.ts';
import type * as Env from '../../mcp/src/install/env.ts';
import type * as Installer from '../../mcp/src/install/installer.ts';

// In `npm run dev`, keeps the MCP server and native host the developer installed
// (`npm run install-mcp`, deployed to ~/.tab-hammer/mcp) in step with this tree's packages/mcp
// source. On start, and after each change under packages/mcp/src or packages/protocol/src, it
// builds the package into a temp folder and copies host.js / server.js over the deployed ones
// that differ, with the launcher pinned to the node install recorded. A new host.js also stops the
// running host, so the extension's bridge reconnects and Chrome starts the new one. It never
// installs: without install-state.json it does nothing, and it never touches browser
// registrations or agent harness configs.

const REPO = path.resolve(import.meta.dirname, '../../..');
const WATCHED = [path.join(REPO, 'packages/mcp/src'), path.join(REPO, 'packages/protocol/src')];
const BUILD_SCRIPT = path.join(REPO, 'packages/mcp/build.ts');
const DEBOUNCE_MS = 300;
const HOST_FILE = 'host.js';
const SERVER_FILE = 'server.js';

type DeployFn = typeof Deploy.deployHost;

export interface Installed {
  /** The deploy folder (install's layout dir). */
  dir: string;
  /** The node install pinned the launcher to (install-state.json's nodePath). */
  nodePath: string;
  os: string;
}

export interface SyncDeps {
  /** The developer's install, or undefined if the MCP isn't installed. */
  installed: () => Promise<Installed | undefined>;
  /** deploy.ts's deployHost and deployServer. */
  deployHost: DeployFn;
  deployServer: DeployFn;
  /** Builds the package (host.js, server.js) into `outDir`; rejects on a build error. */
  build: (outDir: string) => Promise<void>;
  /** Stops running hosts started from `hostPath`; returns how many it stopped. */
  stopHost: (hostPath: string) => Promise<number>;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  /** Parent folder for the temp build. */
  tmpDir?: string;
}

export type SyncResult =
  'not-installed' | 'build-failed' | 'unchanged' | { server: boolean; host: boolean };

const SERVER_LINE =
  '[tab-hammer] Tab Hammer MCP server updated — restart your agent (Claude Code etc.) to pick it up.';
const HOST_LINE = '[tab-hammer] Tab Hammer MCP host updated — the extension reconnects to it.';

function sameFile(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** One build-and-deploy pass. */
export async function syncDeployed(deps: SyncDeps): Promise<SyncResult> {
  const inst = await deps.installed();
  if (!inst) return 'not-installed';
  const stage = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), 'tab-hammer-mcp-build-'));
  try {
    try {
      await deps.build(stage);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).trim().split('\n').slice(0, 6);
      deps.warn(
        `[tab-hammer] MCP build failed; the deployed copy is unchanged.\n${msg.join('\n')}`,
      );
      return 'build-failed';
    }
    const host = !sameFile(path.join(stage, HOST_FILE), path.join(inst.dir, HOST_FILE));
    const server = !sameFile(path.join(stage, SERVER_FILE), path.join(inst.dir, SERVER_FILE));
    if (!host && !server) return 'unchanged';
    const opts = { nodePath: inst.nodePath, os: inst.os, builtDir: stage };
    if (host) deps.deployHost(inst.dir, opts);
    if (server) deps.deployServer(inst.dir, opts);
    if (server) deps.info(SERVER_LINE);
    if (host) {
      if (inst.os === 'win32') {
        deps.info(
          '[tab-hammer] Tab Hammer MCP host updated — reload the extension to start the new one.',
        );
      } else {
        await deps.stopHost(path.join(inst.dir, HOST_FILE));
        deps.info(HOST_LINE);
      }
    }
    return { server, host };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Pids of processes running `hostPath` from `ps -axo pid=,command=` output: the launcher execs
 * `node <hostPath> chrome-extension://…/`, so the path is a whole argument of the command line.
 */
export function findHostPids(psOutput: string, hostPath: string, self = process.pid): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    // A whole argument, so a path with spaces still matches and `host.js.bak` doesn't.
    if (pid !== self && ` ${m[2]} `.includes(` ${hostPath} `)) pids.push(pid);
  }
  return pids;
}

/** Stops the hosts Chrome runs from `hostPath` (macOS and Linux). */
export function stopHostProcesses(hostPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], (err, stdout) => {
      if (err) return resolve(0);
      let n = 0;
      for (const pid of findHostPids(stdout, hostPath)) {
        try {
          process.kill(pid, 'SIGTERM');
          n++;
        } catch {
          /* already gone */
        }
      }
      resolve(n);
    });
  });
}

function buildWithNode(outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BUILD_SCRIPT, outDir], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// The installer and deploy code load at run time, by Node itself, not through Vite's config
// bundle: a file the config imports is a config dependency, and Vite restarts the dev server
// whenever one changes, so a static import would restart it on every edit to the installer.
const load = <T>(rel: string): Promise<T> =>
  import(pathToFileURL(path.join(REPO, rel)).href) as Promise<T>;

async function realInstalled(): Promise<Installed | undefined> {
  const { realEnv } = await load<typeof Env>('packages/mcp/src/install/env.ts');
  const { layout, loadState } = await load<typeof Installer>(
    'packages/mcp/src/install/installer.ts',
  );
  const env = realEnv();
  const state = loadState(env);
  if (!state) return undefined;
  return { dir: layout(env).dir, nodePath: state.nodePath, os: env.os };
}

async function realDeps(logger: {
  info: (msg: string, o: { timestamp: boolean }) => void;
  warn: (msg: string, o: { timestamp: boolean }) => void;
}): Promise<SyncDeps> {
  const { deployHost, deployServer } = await load<typeof Deploy>('packages/mcp/src/deploy.ts');
  return {
    installed: realInstalled,
    deployHost,
    deployServer,
    build: buildWithNode,
    stopHost: stopHostProcesses,
    info: (msg) => logger.info(msg, { timestamp: true }),
    warn: (msg) => logger.warn(msg, { timestamp: true }),
  };
}

/** Runs `run` after changes settle, never two at once (a change mid-run queues one more). */
export function serialDebounce(run: () => Promise<unknown>, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let again = false;
  const start = () => {
    if (running) {
      again = true;
      return;
    }
    running = run().finally(() => {
      running = undefined;
      if (again) {
        again = false;
        start();
      }
    });
  };
  return () => {
    clearTimeout(timer);
    timer = setTimeout(start, delayMs);
  };
}

export function mcpAutodeploy(): Plugin {
  return {
    name: 'tab-hammer:mcp-autodeploy',
    apply: 'serve',
    async configureServer(server) {
      const logger = server.config.logger;
      let deps: SyncDeps;
      try {
        deps = await realDeps(logger);
        if (!(await deps.installed())) {
          logger.info(
            '[tab-hammer] MCP not installed (npm run install-mcp); not keeping it up to date.',
          );
          return;
        }
      } catch (e) {
        logger.warn(`[tab-hammer] MCP autodeploy off: ${e instanceof Error ? e.message : e}`);
        return;
      }
      const run = () =>
        syncDeployed(deps).catch((e: unknown) => {
          deps.warn(`[tab-hammer] MCP autodeploy failed: ${e instanceof Error ? e.message : e}`);
        });
      const trigger = serialDebounce(run, DEBOUNCE_MS);
      server.watcher.add(WATCHED);
      const onChange = (file: string) => {
        if (!WATCHED.some((dir) => file.startsWith(dir + path.sep))) return;
        if (file.split(path.sep).includes('__tests__')) return;
        trigger();
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
      void run();
    },
  };
}

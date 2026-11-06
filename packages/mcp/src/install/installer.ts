// install / uninstall: deploys the host and server, registers the host with every browser found,
// and registers the server with every agent harness found. Everything install changes is written
// to an install state file, and uninstall undoes exactly that: files it created are deleted, the
// text it inserted into a config is cut back out, and registry values it replaced are put back.
import fs from 'node:fs';
import { NATIVE_HOST_NAME } from '@tab-hammer/protocol';
import { deployHost, deployServer, hostManifest, BUILT_DIR } from '../deploy.ts';
import { BROWSERS, detectBrowser, resolveBrowser, type BrowserTarget } from './browsers.ts';
import type { InstallEnv } from './env.ts';
import {
  HARNESSES,
  SERVER_NAME,
  genericSnippet,
  type Harness,
  type ServerCommand,
} from './harnesses.ts';
import { insertEntry, removeEntry, type JsonInsertion } from './jsonEdit.ts';
import { PACKAGE_VERSION } from './version.ts';
import { insertTable, removeTable, tomlTable, type TomlInsertion } from './tomlEdit.ts';

export type BrowserRecord =
  | { kind: 'file'; path: string }
  | {
      kind: 'registry';
      key: string;
      previous?: string;
      /** Parent keys install had to create, deepest first; uninstall removes them if empty. */
      createdKeys?: string[];
    };

export type HarnessRecord =
  | { kind: 'json'; file: string; insertion: JsonInsertion }
  | { kind: 'toml'; file: string; insertion: TomlInsertion }
  | { kind: 'cli' };

export interface InstallState {
  version: 1;
  /** The tab-hammer-mcp version that was deployed. */
  packageVersion?: string;
  nodePath: string;
  serverPath: string;
  launcher: string;
  extensionIds: string[];
  /** Folders install created, outermost first; uninstall removes them if they're left empty. */
  createdDirs: string[];
  browsers: Record<string, BrowserRecord>;
  harnesses: Record<string, HarnessRecord>;
}

export interface Options {
  only?: string[];
  skip?: string[];
  /** Extension IDs to allow besides the built-in ones. */
  extensionIds?: string[];
  /** Where the built host.js and server.js are. */
  builtDir?: string;
  log?: (line: string) => void;
}

export const ALL_IDS = [...BROWSERS.map((b) => b.id), ...HARNESSES.map((h) => h.id)];

/** Where Tab Hammer keeps its files for this user (outside ~/Documents; see deploy.ts). */
export function layout(env: InstallEnv) {
  const p = env.path;
  const base =
    env.os === 'win32' ? p.join(env.localAppData, 'TabHammer') : p.join(env.home, '.tab-hammer');
  const dir = p.join(base, 'mcp');
  return {
    base,
    dir,
    statePath: p.join(dir, 'install-state.json'),
    /** One manifest all Windows registry keys point at. */
    winManifest: p.join(dir, `${NATIVE_HOST_NAME}.json`),
    /** Where `npm run install-mcp` used to put the host. */
    legacyHostDir: p.join(base, 'native-host'),
  };
}

export function serverCommand(env: InstallEnv): ServerCommand {
  return { command: env.nodePath, args: [env.path.join(layout(env).dir, 'server.js')] };
}

export function loadState(env: InstallEnv): InstallState | undefined {
  try {
    return JSON.parse(fs.readFileSync(layout(env).statePath, 'utf8')) as InstallState;
  } catch {
    return undefined;
  }
}

function saveState(env: InstallEnv, state: InstallState): void {
  fs.writeFileSync(layout(env).statePath, JSON.stringify(state, null, 2) + '\n');
}

export function validateIds(ids: string[] | undefined): void {
  const unknown = (ids ?? []).filter((id) => !ALL_IDS.includes(id));
  if (unknown.length) {
    throw new Error(`Unknown target ${unknown.join(', ')}. Known: ${ALL_IDS.join(', ')}`);
  }
}

export function selected(id: string, opts: Options): boolean {
  if (opts.only?.length && !opts.only.includes(id)) return false;
  return !opts.skip?.includes(id);
}

/** mkdir -p that records each folder it had to create. */
function ensureDir(env: InstallEnv, dir: string, state: InstallState): void {
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = env.path.dirname(d)) {
    missing.unshift(d);
    if (env.path.dirname(d) === d) break;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const d of missing) if (!state.createdDirs.includes(d)) state.createdDirs.push(d);
}

const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

export interface Report {
  done: string[];
  skipped: string[];
  failed: string[];
}

export function install(env: InstallEnv, opts: Options = {}): Report {
  validateIds(opts.only);
  validateIds(opts.skip);
  const log = opts.log ?? (() => {});
  const L = layout(env);
  const prev = loadState(env);
  const cmd = serverCommand(env);
  const state: InstallState = {
    version: 1,
    packageVersion: PACKAGE_VERSION,
    nodePath: env.nodePath,
    serverPath: cmd.args[0]!,
    launcher: '',
    extensionIds: [...new Set([...(prev?.extensionIds ?? []), ...(opts.extensionIds ?? [])])],
    createdDirs: prev?.createdDirs ?? [],
    browsers: prev?.browsers ?? {},
    harnesses: prev?.harnesses ?? {},
  };
  const report: Report = { done: [], skipped: [], failed: [] };

  ensureDir(env, L.dir, state);
  const deployOpts = {
    nodePath: env.nodePath,
    os: env.os,
    builtDir: opts.builtDir ?? BUILT_DIR,
    path: env.path,
  };
  state.launcher = deployHost(L.dir, deployOpts);
  deployServer(L.dir, deployOpts);
  const manifest = JSON.stringify(hostManifest(state.launcher, state.extensionIds), null, 2) + '\n';
  if (env.os === 'win32') fs.writeFileSync(L.winManifest, manifest);
  log(`Deployed the host and MCP server to ${L.dir}`);
  // Saved now so a failure below still leaves uninstall able to undo what happened so far.
  saveState(env, state);

  registerBrowsers(env, opts, state, manifest, report, log);
  const anyBrowser = BROWSERS.some((b) => {
    const t = resolveBrowser(env, b);
    return t !== undefined && detectBrowser(env, t);
  });
  if (!anyBrowser) {
    log(
      'No supported browser found (Chrome, Chromium, Brave, Edge, Arc). Install one, then re-run.',
    );
  }
  removeLegacyHost(env);
  saveState(env, state);

  for (const h of HARNESSES) {
    if (!selected(h.id, opts)) continue;
    if (!h.detect(env)) {
      report.skipped.push(h.id);
      continue;
    }
    try {
      registerHarness(env, h, cmd, state);
      report.done.push(h.id);
      log(`Registered with ${h.name} (${h.where(env)})`);
    } catch (err) {
      report.failed.push(h.id);
      log(`Couldn't register with ${h.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    saveState(env, state);
  }
  return report;
}

function registerBrowsers(
  env: InstallEnv,
  opts: Options,
  state: InstallState,
  manifest: string,
  report: Report,
  log: (s: string) => void,
): void {
  const keysDone = new Set<string>();
  for (const b of BROWSERS) {
    if (!selected(b.id, opts)) continue;
    const t = resolveBrowser(env, b);
    // A Tab Hammer manifest already there (the old repo installer wrote one wherever the folder
    // existed) is ours to update, so it doesn't keep pointing at a host that's gone.
    if (!t || !(detectBrowser(env, t) || hasStaleManifest(env, t))) continue;
    if (t.kind === 'file') {
      ensureDir(env, t.manifestDir, state);
      fs.writeFileSync(t.manifestPath, manifest);
      state.browsers[b.id] = { kind: 'file', path: t.manifestPath };
    } else {
      // Several Windows browsers (Chrome's channels) share one key: register it once.
      if (!keysDone.has(t.key)) {
        const earlier = Object.values(state.browsers).find(
          (r) => r.kind === 'registry' && r.key === t.key,
        ) as Extract<BrowserRecord, { kind: 'registry' }> | undefined;
        const previous = earlier ? earlier.previous : env.registry.get(t.key);
        // `reg add` creates missing parents (…\NativeMessagingHosts, even Software\Chromium).
        const createdKeys = earlier?.createdKeys ?? missingParents(env, t.key);
        env.registry.set(t.key, layout(env).winManifest);
        keysDone.add(t.key);
        state.browsers[b.id] = {
          kind: 'registry',
          key: t.key,
          ...(previous !== undefined && { previous }),
          ...(createdKeys.length && { createdKeys }),
        };
      } else {
        const first = Object.values(state.browsers).find(
          (r) => r.kind === 'registry' && r.key === t.key,
        )!;
        state.browsers[b.id] = { ...first };
      }
    }
    report.done.push(b.id);
    log(`Registered the host with ${b.name}`);
  }
}

/** A Tab Hammer manifest pointing at some other host than ours (not one this installer wrote). */
function hasStaleManifest(env: InstallEnv, t: BrowserTarget): boolean {
  if (t.kind !== 'file') return false;
  try {
    const m = JSON.parse(fs.readFileSync(t.manifestPath, 'utf8')) as {
      name?: unknown;
      path?: unknown;
    };
    return m.name === NATIVE_HOST_NAME && !String(m.path).startsWith(layout(env).dir);
  } catch {
    return false;
  }
}

/** Ancestors of `key` (below HKCU\Software) that don't exist yet, deepest first. */
function missingParents(env: InstallEnv, key: string): string[] {
  const out: string[] = [];
  for (
    let k = key.slice(0, key.lastIndexOf('\\'));
    k.includes('\\');
    k = k.slice(0, k.lastIndexOf('\\'))
  ) {
    if (env.registry.exists(k)) break;
    out.push(k);
  }
  return out;
}

/**
 * The old repo installer deployed the host to ~/.tab-hammer/native-host. Remove it once no host
 * manifest on disk points into it any more (an install limited by --only may leave some).
 */
function removeLegacyHost(env: InstallEnv): void {
  const L = layout(env);
  if (!fs.existsSync(L.legacyHostDir)) return;
  const inUse = BROWSERS.some((b) => {
    const t = resolveBrowser(env, b);
    if (t?.kind !== 'file') return false;
    try {
      const m = JSON.parse(fs.readFileSync(t.manifestPath, 'utf8')) as { path?: string };
      return !!m.path?.startsWith(L.legacyHostDir);
    } catch {
      return false;
    }
  });
  if (!inUse) fs.rmSync(L.legacyHostDir, { recursive: true, force: true });
}

function registerHarness(
  env: InstallEnv,
  h: Harness,
  cmd: ServerCommand,
  state: InstallState,
): void {
  const prev = state.harnesses[h.id];
  if (h.kind === 'cli') {
    // `add` refuses to overwrite, so drop an earlier registration first (fine if there was none).
    env.runner.run(h.command, h.removeArgs);
    const r = env.runner.run(h.command, h.addArgs(cmd));
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.status}`);
    state.harnesses[h.id] = { kind: 'cli' };
    return;
  }
  const file = h.file(env);
  const text = readText(file);
  if (h.kind === 'json') {
    const r = insertEntry(
      text,
      h.container,
      SERVER_NAME,
      h.entry(cmd),
      prev?.kind === 'json' ? prev.insertion : undefined,
    );
    ensureDir(env, env.path.dirname(file), state);
    fs.writeFileSync(file, r.text);
    state.harnesses[h.id] = { kind: 'json', file, insertion: r.insertion };
  } else {
    const table = tomlTable(h.table, { command: cmd.command, args: cmd.args });
    const r = insertTable(text, h.table, table, prev?.kind === 'toml' ? prev.insertion : undefined);
    ensureDir(env, env.path.dirname(file), state);
    fs.writeFileSync(file, r.text);
    state.harnesses[h.id] = { kind: 'toml', file, insertion: r.insertion };
  }
}

export function uninstall(env: InstallEnv, opts: Options = {}): Report {
  validateIds(opts.only);
  validateIds(opts.skip);
  const log = opts.log ?? (() => {});
  const L = layout(env);
  const state = loadState(env);
  const report: Report = { done: [], skipped: [], failed: [] };
  if (!state) {
    legacyUninstall(env, opts, report, log);
    return report;
  }

  const where = (r: BrowserRecord) => (r.kind === 'file' ? r.path : r.key);
  const undone = new Set<string>();
  for (const [id, rec] of Object.entries(state.browsers)) {
    if (!selected(id, opts)) continue;
    // Some browsers share a registration (Brave on macOS reads Chrome's folder; Chrome's channels
    // on Windows share a key). It stays while a browser that isn't being uninstalled uses it.
    const kept = Object.entries(state.browsers).some(
      ([other, r]) => other !== id && !selected(other, opts) && where(r) === where(rec),
    );
    if (!kept && !undone.has(where(rec))) {
      if (rec.kind === 'file') fs.rmSync(rec.path, { force: true });
      else if (rec.previous !== undefined) env.registry.set(rec.key, rec.previous);
      else {
        env.registry.delete(rec.key);
        for (const k of rec.createdKeys ?? []) if (env.registry.isEmpty(k)) env.registry.delete(k);
      }
      undone.add(where(rec));
    }
    delete state.browsers[id];
    report.done.push(id);
    log(`Unregistered the host from ${BROWSERS.find((b) => b.id === id)?.name ?? id}`);
  }

  for (const [id, rec] of Object.entries(state.harnesses)) {
    if (!selected(id, opts)) continue;
    const h = HARNESSES.find((x) => x.id === id);
    try {
      if (rec.kind === 'cli') {
        if (h?.kind === 'cli') env.runner.run(h.command, h.removeArgs);
      } else {
        undoFile(rec, h);
      }
      delete state.harnesses[id];
      report.done.push(id);
      log(`Removed from ${h?.name ?? id}`);
    } catch (err) {
      report.failed.push(id);
      log(
        `Couldn't remove from ${h?.name ?? id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (Object.keys(state.browsers).length || Object.keys(state.harnesses).length) {
    saveState(env, state);
    return report;
  }
  fs.rmSync(L.dir, { recursive: true, force: true });
  for (const d of [...state.createdDirs].reverse()) {
    try {
      fs.rmdirSync(d); // only succeeds if empty
    } catch {
      /* not empty or already gone */
    }
  }
  log(`Removed ${L.dir}`);
  return report;
}

function undoFile(
  rec: Extract<HarnessRecord, { kind: 'json' | 'toml' }>,
  h: Harness | undefined,
): void {
  if (!fs.existsSync(rec.file)) return;
  const text = fs.readFileSync(rec.file, 'utf8');
  const r =
    rec.kind === 'json'
      ? removeEntry(
          text,
          h?.kind === 'json' ? h.container : 'mcpServers',
          SERVER_NAME,
          rec.insertion,
        )
      : removeTable(
          text,
          h?.kind === 'toml' ? h.table : `mcp_servers.${SERVER_NAME}`,
          rec.insertion,
        );
  if (r.deleteFile) fs.rmSync(rec.file);
  else if (r.found) fs.writeFileSync(rec.file, r.text);
}

/** No install state (an install by the old repo script): remove our entries wherever they are. */
function legacyUninstall(
  env: InstallEnv,
  opts: Options,
  report: Report,
  log: (s: string) => void,
): void {
  for (const b of BROWSERS) {
    if (!selected(b.id, opts)) continue;
    const t: BrowserTarget | undefined = resolveBrowser(env, b);
    if (!t) continue;
    if (t.kind === 'file' && fs.existsSync(t.manifestPath)) {
      fs.rmSync(t.manifestPath);
      report.done.push(b.id);
    } else if (t.kind === 'registry' && env.registry.get(t.key) !== undefined) {
      env.registry.delete(t.key);
      report.done.push(b.id);
    }
  }
  for (const h of HARNESSES) {
    if (!selected(h.id, opts) || !h.detect(env)) continue;
    if (h.kind === 'cli') {
      if (env.runner.run(h.command, h.removeArgs).status === 0) report.done.push(h.id);
      continue;
    }
    const file = h.file(env);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const r =
      h.kind === 'json' ? removeEntry(text, h.container, SERVER_NAME) : removeTable(text, h.table);
    if (r.found) {
      fs.writeFileSync(file, r.text);
      report.done.push(h.id);
    }
  }
  const L = layout(env);
  fs.rmSync(L.legacyHostDir, { recursive: true, force: true });
  fs.rmSync(L.dir, { recursive: true, force: true });
  log(
    report.done.length
      ? `Removed Tab Hammer from: ${report.done.join(', ')}`
      : 'Nothing to remove.',
  );
}

/** What to paste into a harness we didn't register with. */
export function manualInstructions(env: InstallEnv): string {
  const cmd = serverCommand(env);
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [
    'For any other MCP client, add this server (stdio):',
    genericSnippet(cmd),
    '',
    `Claude Code: claude mcp add -s user ${SERVER_NAME} -- ${q(cmd.command)} ${cmd.args.map(q).join(' ')}`,
  ].join('\n');
}

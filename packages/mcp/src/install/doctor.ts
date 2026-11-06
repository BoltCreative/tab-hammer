// doctor: checks each piece of the bridge on this machine and says what's wrong and how to fix it.
//   1. The deployed host and server, and the node binary they run with.
//   2. Host registration in each browser found.
//   3. Whether a browser has Tab Hammer connected right now (asks it for its tab list).
//   4. The server's registration in each harness found.
import fs from 'node:fs';
import { callBridge } from '../bridgeClient.ts';
import { extensionIds } from '../deploy.ts';
import { socketPath } from '../paths.ts';
import { BROWSERS, detectBrowser, resolveBrowser } from './browsers.ts';
import type { InstallEnv } from './env.ts';
import { HARNESSES, SERVER_NAME } from './harnesses.ts';
import { layout, loadState, selected, type Options } from './installer.ts';
import { readEntry } from './jsonEdit.ts';
import { readTable } from './tomlEdit.ts';

export interface Check {
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** How to fix it, when not ok. */
  fix?: string;
}

const REINSTALL = 'Run `npx tab-hammer-mcp install`.';

export async function doctor(
  env: InstallEnv,
  opts: Options & { timeoutMs?: number; socket?: string } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const L = layout(env);
  const state = loadState(env);

  if (!state) {
    add({ name: 'Install', ok: false, detail: `nothing installed in ${L.dir}`, fix: REINSTALL });
  } else {
    const missing = [state.launcher, state.serverPath, env.path.join(L.dir, 'host.js')].filter(
      (f) => !fs.existsSync(f),
    );
    add(
      missing.length
        ? { name: 'Install', ok: false, detail: `missing ${missing.join(', ')}`, fix: REINSTALL }
        : { name: 'Install', ok: true, detail: L.dir },
    );
    add(
      fs.existsSync(state.nodePath)
        ? { name: 'Node', ok: true, detail: state.nodePath }
        : {
            name: 'Node',
            ok: false,
            detail: `${state.nodePath} no longer exists (Node was moved, upgraded, or uninstalled)`,
            fix: `${REINSTALL} It pins the node you run it with.`,
          },
    );
  }

  const ids = extensionIds(state?.extensionIds);
  let anyBrowser = false;
  for (const b of BROWSERS) {
    if (!selected(b.id, opts)) continue;
    const t = resolveBrowser(env, b);
    if (!t || !detectBrowser(env, t)) continue;
    anyBrowser = true;
    const where = t.kind === 'file' ? t.manifestPath : `HKCU\\${t.key}`;
    const manifestPath = t.kind === 'file' ? t.manifestPath : env.registry.get(t.key);
    const problem = checkManifest(manifestPath, ids);
    add(
      problem
        ? { name: b.name, ok: false, detail: `${problem} (${where})`, fix: REINSTALL }
        : { name: b.name, ok: true, detail: `host registered (${where})` },
    );
  }
  if (!anyBrowser) {
    add({
      name: 'Browsers',
      ok: false,
      detail: 'no Chrome, Chromium, Brave, Edge, or Arc profile found',
      fix: 'Install one of them, then run install again.',
    });
  }

  const sock = opts.socket ?? socketPath(env.os, env.home, () => env.user);
  try {
    const { windows } = await callBridge(sock, 'list_tabs', {}, opts.timeoutMs ?? 5000);
    const tabs = windows.reduce((n, w) => n + w.items.length, 0);
    add({
      name: 'Extension',
      ok: true,
      detail: `connected (${windows.length} windows, ${tabs} top-level items)`,
    });
  } catch (err) {
    add({
      name: 'Extension',
      ok: false,
      detail: `not connected: ${err instanceof Error ? err.message.split('.')[0] : String(err)}`,
      fix:
        'Open your browser with the Tab Hammer extension installed. If it is open, click the ' +
        'Tab Hammer toolbar icon (or reload it in chrome://extensions) so it starts the host; ' +
        'it stops trying after the host fails to start, until it is reloaded.',
    });
  }

  for (const h of HARNESSES) {
    if (!selected(h.id, opts) || !h.detect(env)) continue;
    const expected = state?.serverPath ?? env.path.join(L.dir, 'server.js');
    if (h.kind === 'cli') {
      const r = env.runner.run(h.command, h.getArgs);
      if (r.status === 0) {
        const ok = r.stdout.includes(expected);
        add(
          ok
            ? { name: h.name, ok: true, detail: 'registered' }
            : {
                name: h.name,
                ok: false,
                detail: `"${SERVER_NAME}" points somewhere else`,
                fix: REINSTALL,
              },
        );
      } else {
        add({ name: h.name, ok: false, detail: 'not registered', fix: REINSTALL });
      }
      continue;
    }
    const where = h.file(env);
    const text = fs.existsSync(where) ? fs.readFileSync(where, 'utf8') : '';
    const entry = (
      h.kind === 'json' ? readEntry(text, h.container, SERVER_NAME) : readTable(text, h.table)
    ) as { command?: unknown; args?: unknown } | undefined;
    if (!entry) {
      add({ name: h.name, ok: false, detail: `not registered (${where})`, fix: REINSTALL });
      continue;
    }
    const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];
    const problem =
      typeof entry.command !== 'string' || !fs.existsSync(entry.command)
        ? `its command ${String(entry.command)} doesn't exist`
        : !args[0] || !fs.existsSync(args[0])
          ? `its server ${String(args[0])} doesn't exist`
          : undefined;
    add(
      problem
        ? { name: h.name, ok: false, detail: `${problem} (${where})`, fix: REINSTALL }
        : { name: h.name, ok: true, detail: `registered (${where})` },
    );
  }
  return checks;
}

/** Why a host manifest won't work, or undefined if it will. */
function checkManifest(manifestPath: string | undefined, ids: string[]): string | undefined {
  if (!manifestPath) return 'host not registered';
  let m: { path?: string; allowed_origins?: string[] };
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof m;
  } catch {
    return `host manifest ${manifestPath} is missing or unreadable`;
  }
  if (!m.path || !fs.existsSync(m.path)) return `the host it points to (${m.path}) is missing`;
  const allowed = new Set(m.allowed_origins ?? []);
  const missing = ids.filter((id) => !allowed.has(`chrome-extension://${id}/`));
  if (missing.length) return `the manifest doesn't allow extension ${missing.join(', ')}`;
  return undefined;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  const fixes = checks.filter((c) => !c.ok && c.fix);
  if (fixes.length) {
    lines.push('', 'To fix:');
    for (const c of fixes) lines.push(`  ${c.name}: ${c.fix}`);
  } else {
    lines.push('', 'Everything looks good.');
  }
  return lines.join('\n');
}

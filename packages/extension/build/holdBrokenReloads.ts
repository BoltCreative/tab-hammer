import { rolldown } from 'rolldown';
import type { Plugin } from 'vite';

// In `npm run dev`, @crxjs/vite-plugin reloads the whole extension (chrome.runtime.reload) as soon
// as any file the service worker imports changes. If that lands while the files are half edited
// (one file asks for an export another no longer has), the new service worker fails to start
// ("Service worker registration failed. Status code: 15"). crxjs's reload client lives inside
// that service worker, so nothing reloads it again: the extension stays dead, and the toolbar
// icon does nothing, until the user reloads it by hand. Claude edits these files while the user's
// Chrome runs the dev build, so this happens.
//
// This plugin holds crxjs's reload while the service worker's code doesn't link (a missing export
// or a syntax error), and sends it once a later change makes the code whole again.

const RUNTIME_RELOAD = 'crx:runtime-reload';

/** Bundles the entry in memory; returns the first error, or null if it links. */
export async function findLinkError(entry: string): Promise<string | null> {
  try {
    const bundle = await rolldown({
      input: entry,
      // Packages are resolved by Vite at runtime; only check the extension's own files link.
      external: (id) => !id.startsWith('.') && !id.startsWith('/'),
      logLevel: 'silent',
    });
    try {
      await bundle.generate({ format: 'esm' });
    } finally {
      await bundle.close();
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function isRuntimeReload(payload: unknown): boolean {
  const p = payload as { type?: unknown; event?: unknown } | null;
  return p?.type === 'custom' && p.event === RUNTIME_RELOAD;
}

export interface ReloadGate {
  /** Every payload Vite sends to its clients; runtime reloads wait for a clean check. */
  send: (payload: unknown) => void;
  /** A file changed: if a reload is being held, check again. */
  fileChanged: () => void;
  /** Resolves once queued checks are done (for tests). */
  settled: () => Promise<void>;
}

export function createReloadGate(opts: {
  forward: (payload: unknown) => void;
  check: () => Promise<string | null>;
  warn: (msg: string) => void;
  info: (msg: string) => void;
}): ReloadGate {
  let held: unknown;
  let queue = Promise.resolve();
  let latest = 0;

  // Checks run one at a time, and only the newest request acts, so a burst of changes sends at
  // most one reload, and a slow early check can't release a reload a later check found broken.
  const tryRelease = (payload: unknown) => {
    const seq = ++latest;
    queue = queue.then(async () => {
      if (seq !== latest) return;
      const error = await opts.check();
      if (seq !== latest) return;
      if (error) {
        if (held === undefined) {
          opts.warn(
            `[tab-hammer] holding the extension reload: the service worker won't link.\n${error}`,
          );
        }
        held = payload;
        return;
      }
      if (held !== undefined) opts.info('[tab-hammer] service worker links again; reloading.');
      held = undefined;
      opts.forward(payload);
    });
  };

  return {
    send(payload) {
      if (isRuntimeReload(payload)) tryRelease(payload);
      else opts.forward(payload);
    },
    fileChanged() {
      if (held !== undefined) tryRelease(held);
    },
    settled: () => queue,
  };
}

export function holdBrokenReloads(entry: string): Plugin {
  let gate: ReloadGate | undefined;
  return {
    name: 'tab-hammer:hold-broken-reloads',
    apply: 'serve',
    configureServer(server) {
      const send = server.ws.send.bind(server.ws) as (...args: unknown[]) => void;
      gate = createReloadGate({
        forward: (payload) => send(payload),
        check: () => findLinkError(entry),
        warn: (msg) => server.config.logger.warn(msg),
        info: (msg) => server.config.logger.info(msg),
      });
      // crxjs calls server.ws.send(...) for the reload, so route sends through the gate.
      server.ws.send = ((...args: unknown[]) => {
        if (args.length === 1) gate!.send(args[0]);
        else send(...args);
      }) as typeof server.ws.send;
    },
    handleHotUpdate() {
      gate?.fileChanged();
    },
  };
}

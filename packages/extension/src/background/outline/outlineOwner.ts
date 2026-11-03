// The service worker's copy of the outline: it mirrors Chrome into it, persists every change to
// IndexedDB, broadcasts it to connected views, and re-links windows Chrome restores (or the user
// reopens) to the trash or shutdown rows they came from.
//
// Event listeners only record data and queue work. Every outline change runs in one serial queue,
// behind init, so no two jobs ever read and write the outline at once.
import { matchRestored } from '../../model/outline/applyMatch';
import { closeWindow, expireTrash, startFresh } from '../../model/outline/lifecycle';
import { reconcile, replaceTabId } from '../../model/outline/reconcile';
import type { ChromeSnapshot, Outline } from '../../model/outline/types';
import { SWAP_KEY } from '../../shared/captureSwap';
import {
  OUTLINE_PORT,
  type LiveDetails,
  type OutlineCommand,
  type OutlineStateMessage,
} from '../../shared/outlineMessages';
import { browserSession } from '../session';
import { liveDetails, readSnapshot } from './chromeOutline';
import { loadOutline, saveOutline } from './outlineStore';
import { createSettleTracker } from './settleTracker';

export interface OutlineOwner {
  /** Resolves once the job queue is empty. */
  idle(): Promise<void>;
  /** Test hook: the fresh-launch path (startFresh + reconcile) without relaunching Chrome. */
  simulateBrowserRestart(): Promise<void>;
  command(c: OutlineCommand): Promise<void>;
  /** The in-memory outline, Chrome IDs included. */
  outline(): Outline;
}

/** chrome.storage.local key of this install's ID, stamped on every window record it creates. */
export const INSTALL_ID_KEY = 'installId';

async function readInstallId(): Promise<string> {
  const { [INSTALL_ID_KEY]: stored } = await chrome.storage.local.get(INSTALL_ID_KEY);
  if (typeof stored === 'string') return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
  return id;
}

const newId = () => crypto.randomUUID();

function sameLive(a: LiveDetails | null, b: LiveDetails): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** Registers the outline's Chrome listeners. Must run synchronously at service worker top level. */
export function registerOutline(): OutlineOwner {
  let outline: Outline = { windows: [] };
  let persisted: Outline = outline; // what IndexedDB holds; saves diff against it
  let live: LiveDetails | null = null;
  let installId = '';
  let sessionId = '';
  let initialized = false;

  // Recorded by listeners, read by jobs.
  const launchUrls = new Map<number, string>(); // chromeTabId -> first address it had
  const closingWindowIds = new Set<number>();
  let focusEvent: number | undefined; // latest onFocusChanged window, not yet checked
  let focusedWindowId: number | null = null;
  const ports = new Set<chrome.runtime.Port>();

  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      if (!initialized) await init(); // retried by the next job if it failed
      return job();
    });
    tail = run.then(
      () => undefined,
      (err: unknown) => console.error('[outline]', err),
    );
    return run;
  }

  const tracker = createSettleTracker({
    onSettled: (ids) => void enqueue(() => step({ after: (o) => matchSettled(o, ids) })),
  });

  function matchSettled(o: Outline, chromeWindowIds: number[]): Outline {
    const settled = new Set(chromeWindowIds);
    const ids = o.windows
      .filter((w) => w.provisional && settled.has(w.chromeWindowId!))
      .map((w) => w.id);
    return ids.length === 0 ? o : matchRestored(o, ids, Date.now(), newId).outline;
  }

  function message(): OutlineStateMessage {
    return { type: 'outline', state: { windows: outline.windows, live: live! } };
  }

  function post(port: chrome.runtime.Port): void {
    try {
      port.postMessage(message());
    } catch {
      ports.delete(port); // disconnected between the event and now
    }
  }

  /** Adopts `next` (and `nextLive`), persisting and broadcasting whatever changed. */
  async function commit(next: Outline, nextLive: LiveDetails, force = false): Promise<void> {
    const outlineChanged = next !== outline;
    const liveChanged = !sameLive(live, nextLive);
    outline = next;
    live = nextLive;
    if (force || next !== persisted) {
      await saveOutline(persisted, next, sessionId);
      persisted = next;
    }
    if (initialized && (outlineChanged || liveChanged)) for (const p of ports) post(p);
  }

  function updateFocus(snapshot: ChromeSnapshot): void {
    const present = new Set(snapshot.windowIds);
    // Tab Hammer's popup isn't a normal window, so it never takes the focus here.
    if (focusEvent !== undefined && present.has(focusEvent)) focusedWindowId = focusEvent;
    focusEvent = undefined;
    if (focusedWindowId !== null && !present.has(focusedWindowId)) focusedWindowId = null;
  }

  type Op = (o: Outline) => Outline;
  const same: Op = (o) => o;

  /**
   * One round of work: applies `before` (an explicit Chrome event), reconciles with a fresh
   * snapshot, applies `after` (matching settled windows), then persists and broadcasts.
   */
  async function step({
    before = same,
    after = same,
    force = false,
  }: { before?: Op; after?: Op; force?: boolean } = {}): Promise<void> {
    const snapshot = await readSnapshot(launchUrls);
    updateFocus(snapshot);
    const now = Date.now();
    const r = reconcile(before(outline), { snapshot, closingWindowIds, now, newId, installId });
    for (const id of r.newProvisional) tracker.touch(id);
    await commit(after(expireTrash(r.outline, now)), liveDetails(snapshot, focusedWindowId), force);
  }

  async function init(): Promise<void> {
    installId = await readInstallId();
    const { meta, outline: loaded } = await loadOutline();
    outline = persisted = loaded;
    sessionId = await browserSession.current();
    const now = Date.now();
    // A new browser session: Chrome IDs from the last one mean nothing now.
    if (meta?.sessionId !== sessionId) outline = startFresh(outline, now);
    outline = expireTrash(outline, now);
    if (focusEvent === undefined) {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      focusEvent = w?.id;
    }
    // Saved even if unchanged, so the meta records this session and a worker restart isn't
    // mistaken for a fresh launch.
    await step({ force: true });
    for (const w of outline.windows) if (w.provisional) tracker.touch(w.chromeWindowId!);
    initialized = true;
    for (const p of ports) post(p);
  }

  let reconcileQueued = false;
  function scheduleReconcile(): void {
    if (reconcileQueued) return;
    reconcileQueued = true;
    void enqueue(() => {
      reconcileQueued = false;
      return step();
    });
  }

  /** Tab churn in a window still waiting to be matched restarts its quiet period. */
  function touchIfProvisional(chromeWindowId: number): void {
    if (outline.windows.some((w) => w.provisional && w.chromeWindowId === chromeWindowId))
      tracker.touch(chromeWindowId);
  }

  function noteLaunchUrl(tabId: number, url: string | undefined): void {
    if (url && !launchUrls.has(tabId)) launchUrls.set(tabId, url);
  }

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) noteLaunchUrl(tab.id, tab.url || tab.pendingUrl);
    touchIfProvisional(tab.windowId);
    scheduleReconcile();
  });
  // The first committed navigation is the address Chrome restored the tab with, even if the
  // page later redirects (an expired login, a challenge page).
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) noteLaunchUrl(d.tabId, d.url);
  });
  chrome.tabs.onRemoved.addListener((tabId, info) => {
    launchUrls.delete(tabId);
    if (info.isWindowClosing) {
      // The window's own removal closes its record (with every tab) once it lands.
      closingWindowIds.add(info.windowId);
      return;
    }
    touchIfProvisional(info.windowId);
    scheduleReconcile();
  });
  chrome.tabs.onMoved.addListener((_id, info) => {
    touchIfProvisional(info.windowId);
    scheduleReconcile();
  });
  chrome.tabs.onAttached.addListener((_id, info) => {
    touchIfProvisional(info.newWindowId);
    scheduleReconcile();
  });
  chrome.tabs.onDetached.addListener((_id, info) => {
    touchIfProvisional(info.oldWindowId);
    scheduleReconcile();
  });
  chrome.tabs.onUpdated.addListener(scheduleReconcile);
  chrome.tabs.onActivated.addListener(scheduleReconcile);
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const launch = launchUrls.get(removedTabId);
    launchUrls.delete(removedTabId);
    noteLaunchUrl(addedTabId, launch);
    // Reconciling too picks up the new tab's live details.
    void enqueue(() => step({ before: (o) => replaceTabId(o, addedTabId, removedTabId) }));
  });

  chrome.windows.onCreated.addListener(scheduleReconcile);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) focusEvent = windowId;
    scheduleReconcile();
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    void enqueue(() => {
      closingWindowIds.delete(windowId);
      tracker.forget(windowId);
      return step({
        before: (o) => {
          // A window the outline no longer holds (or never did) closes nothing.
          const rec = o.windows.find((w) => w.state === 'live' && w.chromeWindowId === windowId);
          return rec ? closeWindow(o, rec.id, Date.now()) : o;
        },
      });
    });
  });

  chrome.tabGroups.onCreated.addListener(scheduleReconcile);
  chrome.tabGroups.onUpdated.addListener(scheduleReconcile);
  chrome.tabGroups.onRemoved.addListener(scheduleReconcile);
  chrome.tabGroups.onMoved.addListener(scheduleReconcile);
  // A capture swap starting or ending hides or reveals its temporary tab.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SWAP_KEY in changes) scheduleReconcile();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== OUTLINE_PORT) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    // Init posts to every port it finds once done; after that, a new port gets the state now.
    if (initialized) post(port);
  });

  void enqueue(async () => undefined); // runs init

  return {
    async idle() {
      for (;;) {
        const t = tail;
        await t;
        if (t === tail) return;
      }
    },
    simulateBrowserRestart: () =>
      enqueue(() => {
        closingWindowIds.clear();
        return step({ before: (o) => startFresh(o, Date.now()) });
      }),
    command: async () => {
      throw new Error('not implemented');
    },
    outline: () => outline,
  };
}

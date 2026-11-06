// The service worker's copy of the outline: it mirrors Chrome into it, persists every change to
// IndexedDB, broadcasts it to connected views, and re-links windows Chrome restores (or the user
// reopens) to the trash or shutdown rows they came from.
//
// Event listeners only record data and queue work. Every outline change runs in one serial queue,
// behind init, so no two jobs ever read and write the outline at once.
import { matchRestored } from '../../model/outline/applyMatch';
import {
  closeWindow,
  deleteWindow,
  expireTrash,
  findRow,
  hibernate,
  renameWindow,
  startFresh,
  trash,
} from '../../model/outline/lifecycle';
import { attachOpened, planOpen } from '../../model/outline/open';
import { moveWindows, placeWindowAfter } from '../../model/outline/order';
import { attachGroup, placeTabs } from '../../model/outline/place';
import { reconcile, replaceTabId } from '../../model/outline/reconcile';
import type { ChromeSnapshot, Effects, Outline, WindowRec } from '../../model/outline/types';
import { copyForOpen } from '../../model/sync/copy';
import { toSyncWindow, type SyncWindow } from '../../model/sync/export';
import { restoreWindows, selfRestoreWindows } from '../../model/sync/restore';
import { SWAP_KEY } from '../../shared/captureSwap';
import {
  OUTLINE_PORT,
  isOutlineCommandRequest,
  type LiveDetails,
  type OutlineCommand,
  type OutlineCommandReply,
  type OutlineStateMessage,
} from '../../shared/outlineMessages';
import { browserSession } from '../session';
import { createGroup, liveDetails, openPlanned, readSnapshot, runEffects } from './chromeOutline';
import { createJobQueue } from './jobQueue';
import { createLaunchUrls } from './launchUrls';
import { loadOutline, saveOutline } from './outlineStore';
import { createSelfClosing } from './selfClosing';
import { createSettleTracker } from './settleTracker';

export interface OutlineOwner {
  /** Resolves once the job queue is empty. */
  idle(): Promise<void>;
  /** Runs a command; resolves with the Chrome window it opened (newWindow, moveToNewWindow). */
  command(c: OutlineCommand): Promise<number | undefined>;
  /**
   * Runs `create` (which opens a Chrome window) and records the window it opens as known: Tab
   * Hammer opened it, so it isn't a candidate for re-linking to a closed window. The window is
   * returned even if recording it fails (the error is logged).
   */
  openWindow(
    create: () => Promise<chrome.windows.Window | undefined>,
  ): Promise<chrome.windows.Window | undefined>;
  /** The in-memory outline, Chrome IDs included. */
  outline(): Outline;
  /** The outline as sync windows (machine-local fields left out), once queued work is done. */
  exportWindows(): Promise<SyncWindow[]>;
  /** This install's ID (chrome.storage.local), created at init if it had none. */
  installId(): Promise<string>;
  /** The outline database held nothing when this worker started (a new or wiped profile). */
  wasFresh(): Promise<boolean>;
  /**
   * Adds the windows the outline lacks, hibernated (see restoreWindows); returns how many. With
   * `selfRestore`, keeps the file's trash and re-links open windows (see selfRestoreWindows).
   */
  restoreWindows(windows: SyncWindow[], selfRestore: boolean): Promise<number>;
  /** Opens a copy of another outline's window, group, or tab here, with new IDs. */
  openCopy(window: SyncWindow, rowId: string): Promise<void>;
}

export interface OutlineOptions {
  /** The persisted outline changed (called after each change is saved). */
  onChange?: () => void;
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
export function registerOutline(opts: OutlineOptions = {}): OutlineOwner {
  let outline: Outline = { windows: [] };
  let persisted: Outline = outline; // what IndexedDB holds; saves diff against it
  let live: LiveDetails | null = null;
  let installId = '';
  let sessionId = '';
  let initialized = false;
  let fresh = false;

  // Recorded by listeners, read by jobs.
  const launchUrls = createLaunchUrls(
    {
      getAll: () => chrome.storage.session.get(null),
      set: (items) => chrome.storage.session.set(items),
      remove: (keys) => chrome.storage.session.remove(keys),
    },
    (err) => console.error('[outline] launch URLs', err),
  );
  const closingWindowIds = new Set<number>();
  const selfClosing = createSelfClosing(); // windows and tabs this worker is closing
  const selfOpened = new Set<number>(); // windows this worker opened, not yet recorded
  // Windows this worker opened whose rows go after a given window (null: the end), applied by the
  // first reconcile that records them.
  const placeAfter = new Map<number, string | null>();
  let focusEvent: number | undefined; // latest onFocusChanged window, not yet checked
  let focusedWindowId: number | null = null;
  const ports = new Set<chrome.runtime.Port>();

  // Every outline change runs here, one at a time, behind init (retried by the next job if it fails).
  const queue = createJobQueue({
    init: () => init(),
    onError: (err) => console.error('[outline]', err),
  });
  const enqueue = queue.enqueue;

  const tracker = createSettleTracker({
    onSettled: (ids) => void enqueue(() => step({ after: (o) => matchSettled(o, ids) })),
  });

  function matchSettled(o: Outline, chromeWindowIds: number[]): Outline {
    const settled = new Set(chromeWindowIds);
    const ids = o.windows
      .filter((w) => w.provisional && settled.has(w.chromeWindowId!))
      .map((w) => w.id);
    return ids.length === 0 ? o : matchRestored(o, ids, Date.now());
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

  /**
   * Adopts `next` (and `nextLive`), broadcasting and persisting whatever changed. Broadcast comes
   * first, so a failed save doesn't hide the change from views; the next save, which diffs
   * against what was last saved, retries it.
   */
  async function commit(next: Outline, nextLive: LiveDetails, force = false): Promise<void> {
    const outlineChanged = next !== outline;
    const liveChanged = !sameLive(live, nextLive);
    outline = next;
    live = nextLive;
    if (initialized && (outlineChanged || liveChanged)) for (const p of ports) post(p);
    if (force || next !== persisted) {
      const changed = next !== persisted;
      await saveOutline(persisted, next, sessionId);
      persisted = next;
      if (changed) opts.onChange?.();
    }
  }

  function updateFocus(snapshot: ChromeSnapshot): void {
    const present = new Set(snapshot.windowIds);
    // Tab Hammer's popup isn't a normal window, so it never takes the focus here.
    if (focusEvent !== undefined && present.has(focusEvent)) focusedWindowId = focusEvent;
    focusEvent = undefined;
    if (focusedWindowId !== null && !present.has(focusedWindowId)) focusedWindowId = null;
  }

  /** `o` with the window Chrome has as `chromeWindowId` no longer provisional. */
  function known(o: Outline, chromeWindowId: number): Outline {
    if (!o.windows.some((w) => w.provisional && w.chromeWindowId === chromeWindowId)) return o;
    return {
      windows: o.windows.map((w) => {
        if (!w.provisional || w.chromeWindowId !== chromeWindowId) return w;
        const next = { ...w };
        delete next.provisional;
        return next;
      }),
    };
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
    const snapshot = selfClosing.filter(await readSnapshot(launchUrls.urls));
    updateFocus(snapshot);
    const now = Date.now();
    const r = reconcile(before(outline), { snapshot, closingWindowIds, now, newId, installId });
    let next = r.outline;
    for (const id of r.newProvisional) {
      if (selfOpened.delete(id)) next = known(next, id);
      else tracker.touch(id);
    }
    for (const [chromeId, afterId] of placeAfter) {
      const rec = next.windows.find((w) => w.state === 'live' && w.chromeWindowId === chromeId);
      if (!rec) continue;
      placeAfter.delete(chromeId);
      next = placeWindowAfter(next, rec.id, afterId);
    }
    await commit(after(expireTrash(next, now)), liveDetails(snapshot, focusedWindowId), force);
  }

  async function init(): Promise<void> {
    installId = await readInstallId();
    await launchUrls.load();
    const { meta, outline: loaded } = await loadOutline();
    fresh = meta === undefined;
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

  const scheduleReconcile = queue.coalesced(() => step());

  /** Closes what a model op let go of, keeping it out of reconcile until Chrome reports it gone. */
  async function close(effects: Effects): Promise<void> {
    selfClosing.add(effects);
    selfClosing.release(await runEffects(effects));
  }

  /**
   * One command, run as a single job: reconcile, apply the model op, persist and broadcast, then
   * act in Chrome. Holding the queue across the Chrome calls means the windows and tabs this
   * creates are attached before their events' reconcile runs, so they never become provisional.
   */
  async function runCommand(c: OutlineCommand): Promise<number | undefined> {
    await step();
    const now = Date.now();
    switch (c.cmd) {
      case 'hibernate':
      case 'trash': {
        // The onRemoved events that follow find no live record and do nothing.
        const r = (c.cmd === 'hibernate' ? hibernate : trash)(outline, c.ids, now);
        await commit(r.outline, live!);
        await close(r.effects);
        return;
      }
      case 'rename':
        await commit(renameWindow(outline, c.windowId, c.name, now), live!);
        return;
      case 'deleteForever':
        await commit(deleteWindow(outline, c.windowId), live!);
        return;
      case 'open':
        await openRow(c.id);
        return;
      case 'place': {
        const r = placeTabs(outline, c.placement, now, newId);
        await commit(r.outline, live!);
        await close(r.effects);
        const attached: [string, number][] = [];
        for (const g of r.regroup) {
          const rec = findRow(outline, g.groupId)?.group;
          const [first, ...more] = g.chromeTabIds;
          if (!rec || first === undefined) continue;
          try {
            attached.push([g.groupId, await createGroup(g.chromeWindowId, [first, ...more], rec)]);
          } catch (err) {
            console.error('[outline] regroup', err); // the tabs stay ungrouped
          }
        }
        if (attached.length > 0) {
          await step({
            before: (o) =>
              attached.reduce((acc, [id, chromeId]) => attachGroup(acc, id, chromeId), o),
          });
        }
        return;
      }
      case 'moveWindows':
        await commit(moveWindows(outline, c.ids, c.anchorId, c.side), live!);
        return;
      case 'newWindow':
        return (await createWindow({ focused: true }, c.afterWindowId))?.chromeWindowId;
      case 'moveToNewWindow':
        return moveToNewWindow(c.tabIds);
      default: {
        // Runtime messages aren't validated past `command` being an object.
        const unknown: never = c;
        throw new Error(`unknown outline command: ${String((unknown as { cmd?: unknown }).cmd)}`);
      }
    }
  }

  /**
   * Opens a Chrome window (as known: Tab Hammer opened it) and records it, its row placed after
   * `afterId` (null: at the end); part of a job. Returns its record once reconciled, if it is.
   */
  async function createWindow(
    props: chrome.windows.CreateData,
    afterId: string | null,
  ): Promise<WindowRec | undefined> {
    const w = await chrome.windows.create(props);
    const id = w?.id;
    if (id === undefined) throw new Error('Chrome opened no window');
    selfOpened.add(id);
    placeAfter.set(id, afterId);
    await step();
    return outline.windows.find((r) => r.state === 'live' && r.chromeWindowId === id);
  }

  /**
   * Moves tab records into a brand-new window at the end of the outline, as Chrome does when a tab
   * is dragged out of its strip: live tabs move in Chrome (out of their groups), and hibernated
   * ones follow in the outline. With no live tab among them, the new window is hibernated.
   */
  async function moveToNewWindow(tabIds: string[]): Promise<number | undefined> {
    const recs = tabIds.flatMap((id) => {
      const row = findRow(outline, id);
      return row?.tab && row.window.state !== 'trashed' ? [row.tab] : [];
    });
    if (recs.length === 0) return undefined;
    const liveIds = recs.flatMap((t) => t.chromeTabId ?? []);
    let target: WindowRec | undefined;
    if (liveIds.length > 0) {
      const [first, ...rest] = liveIds;
      // Gone between the drop and now: the next reconcile records wherever Chrome has it.
      target = await createWindow({ tabId: first, focused: true }, null);
      if (target && rest.length > 0) {
        await chrome.tabs.move(rest, { windowId: target.chromeWindowId!, index: -1 });
        await step();
      }
    } else {
      const now = Date.now();
      target = {
        id: newId(),
        state: 'hibernated',
        lastLiveAt: now,
        originInstallId: installId,
        modifiedAt: now,
        tabs: [],
        groups: [],
      };
      await commit({ windows: [...outline.windows, target] }, live!);
    }
    if (!target) return undefined;
    const r = placeTabs(
      outline,
      {
        windowId: target.id,
        beforeTabId: null,
        tabs: recs.map((t) => ({ id: t.id, groupId: null })),
      },
      Date.now(),
      newId,
    );
    await commit(r.outline, live!);
    await close(r.effects);
    return target.chromeWindowId;
  }

  /** Opens a hibernated or trashed row in Chrome; part of a job. */
  async function openRow(id: string): Promise<void> {
    // A trash entry always reopens as a whole window, whichever of its rows was opened.
    const row = findRow(outline, id);
    const plan = planOpen(outline, row?.window.state === 'trashed' ? row.window.id : id);
    if (!plan) return;
    const opened = await openPlanned(plan); // a failed window create leaves the outline as is
    if (opened.tabs.length === 0) throw new Error('Chrome opened none of the tabs');
    await step({ before: (o) => attachOpened(o, plan.windowId, opened, Date.now()) });
  }

  /** Tab churn in a window still waiting to be matched restarts its quiet period. */
  function touchIfProvisional(chromeWindowId: number): void {
    if (outline.windows.some((w) => w.provisional && w.chromeWindowId === chromeWindowId))
      tracker.touch(chromeWindowId);
  }

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) launchUrls.note(tab.id, tab.url || tab.pendingUrl);
    touchIfProvisional(tab.windowId);
    scheduleReconcile();
  });
  // The first committed navigation is the address Chrome restored the tab with, even if the
  // page later redirects (an expired login, a challenge page).
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) launchUrls.note(d.tabId, d.url);
  });
  chrome.tabs.onRemoved.addListener((tabId, info) => {
    launchUrls.forget(tabId);
    selfClosing.tabRemoved(tabId);
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
    const launch = launchUrls.urls.get(removedTabId);
    launchUrls.forget(removedTabId);
    launchUrls.note(addedTabId, launch);
    // Reconciling too picks up the new tab's live details.
    void enqueue(() => step({ before: (o) => replaceTabId(o, addedTabId, removedTabId) }));
  });

  chrome.windows.onCreated.addListener(scheduleReconcile);
  chrome.windows.onBoundsChanged.addListener(scheduleReconcile);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) focusEvent = windowId;
    scheduleReconcile();
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    void enqueue(() => {
      closingWindowIds.delete(windowId);
      selfClosing.windowRemoved(windowId);
      selfOpened.delete(windowId);
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

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isOutlineCommandRequest(msg)) return false;
    void enqueue(() => runCommand(msg.command)).then(
      (windowId) => {
        const reply: OutlineCommandReply = { ok: true };
        if (windowId !== undefined) reply.windowId = windowId;
        sendResponse(reply);
      },
      (err: unknown) =>
        sendResponse({ ok: false, error: String(err) } satisfies OutlineCommandReply),
    );
    return true; // the reply is async
  });

  void enqueue(async () => undefined); // runs init

  return {
    idle: () => queue.idle(),
    command: (c) => enqueue(() => runCommand(c)),
    outline: () => outline,
    exportWindows: () => enqueue(async () => outline.windows.map(toSyncWindow)),
    wasFresh: () => enqueue(async () => fresh),
    installId: () => enqueue(async () => installId),
    restoreWindows: (windows, selfRestore) =>
      enqueue(async () => {
        await step();
        const now = Date.now();
        const r = selfRestore
          ? selfRestoreWindows(outline, windows, { now, newId })
          : restoreWindows(outline, windows, { now, newId, keepTrash: false });
        await commit(r.outline, live!);
        return r.added.length;
      }),
    openCopy: (window, rowId) =>
      enqueue(async () => {
        await step();
        const now = Date.now();
        const rec = copyForOpen(window, rowId, { now, newId, installId });
        if (!rec) throw new Error('Nothing to open');
        // The copy goes in hibernated at the bottom, then opens like any hibernated window.
        await commit({ windows: [...outline.windows, rec] }, live!);
        await openRow(rec.id);
      }),
    async openWindow(create) {
      // The create runs outside the queue, so a failing outline never blocks or fails it.
      const w = await create();
      const id = w?.id;
      if (id === undefined) return w;
      selfOpened.add(id);
      // A reconcile may already have recorded it as provisional: make that record known now, or
      // leave the ID for the reconcile that first finds the window's tabs.
      await enqueue(() =>
        step({
          before: (o) => {
            if (!o.windows.some((r) => r.state === 'live' && r.chromeWindowId === id)) return o;
            selfOpened.delete(id);
            tracker.forget(id);
            return known(o, id);
          },
        }),
      ).catch((err: unknown) => console.error('[outline] record opened window', err));
      return w;
    },
  };
}

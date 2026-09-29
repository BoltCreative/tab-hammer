// On-demand screenshots of background tabs, for the hover card. captureVisibleTab can only see a
// window's visible tab, but the DevTools protocol's Page.captureScreenshot draws a background tab
// offscreen. Attaching the debugger shows Chrome's "started debugging this browser" infobar, so
// the debugger is attached only for the screenshot itself and detached before anything else.
// Chrome and the store are injected so the skip rules, the detach ordering, and the minimized-
// window swap are unit-testable.
import type { CaptureOutcome, OutcomeEntry } from '../shared/captureOutcomes';
import type { SwapRecord } from '../shared/captureSwap';
import { isCapturableUrl } from '../shared/previewPolicy';
import { message, type Shot } from './captureWindow';

type TabInfo = Pick<
  chrome.tabs.Tab,
  'id' | 'windowId' | 'index' | 'url' | 'status' | 'incognito' | 'discarded' | 'active' | 'groupId'
>;
type WindowInfo = Pick<chrome.windows.Window, 'type' | 'state' | 'incognito'>;

export interface OffscreenDeps {
  /** The `debugger` permission and `<all_urls>` host access. */
  hasPermission: () => Promise<boolean>;
  getTab: (tabId: number) => Promise<TabInfo>;
  getWindow: (windowId: number) => Promise<WindowInfo>;
  viewWindowId: () => Promise<number | undefined>; // Tab Hammer's own window
  tabsInWindow: (windowId: number) => Promise<TabInfo[]>;
  /** IDs of the window's collapsed tab groups. */
  collapsedGroups: (windowId: number) => Promise<number[]>;
  activate: (tabId: number) => Promise<void>;
  /** Opens an active about:blank tab in the window and returns its ID. */
  createBlankTab: (windowId: number) => Promise<number>;
  removeTab: (tabId: number) => Promise<void>;
  /** Persists (or, with undefined, clears) the in-progress swap, for crash recovery and the view. */
  saveSwap: (record: SwapRecord | undefined) => Promise<void>;
  loadSwap: () => Promise<SwapRecord | undefined>;
  attach: (tabId: number) => Promise<void>;
  detach: (tabId: number) => Promise<void>;
  /** CDP Page.captureScreenshot; resolves with base64 JPEG data. */
  screenshot: (tabId: number) => Promise<string>;
  /** Captures a window's visible tab the usual way (captureVisibleTab), no infobar. */
  captureVisible: (windowId: number) => Promise<CaptureOutcome>;
  downscale: (dataUrl: string) => Promise<Shot>;
  save: (url: string, shot: Shot & { capturedAt: number }) => Promise<void>;
  /** The tab's latest recorded on-demand outcome, for the failure cooldown. */
  previousOutcome: (tabId: number) => Promise<OutcomeEntry | undefined>;
  /** Records the attempt's outcome for the tab's hover card. Failures are ignored. */
  record: (tabId: number, outcome: CaptureOutcome) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export const SCREENSHOT_TIMEOUT_MS = 5000;
/** After a failed capture, re-hovering the tab within this long reuses the failure. */
export const FAILURE_COOLDOWN_MS = 60_000;

/** The capture options proven to work for background tabs (fromSurface: false is refused). */
export const SCREENSHOT_PARAMS = {
  format: 'jpeg',
  quality: 70,
  fromSurface: true,
  captureBeyondViewport: false,
} as const;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Picks the tab to show in place of `target` while it is captured: the nearest by index that is
 * not discarded (activating it would reload it) and not in a collapsed group (activating it
 * would expand the group for good). Undefined if there is none.
 */
export function pickStandIn(
  target: TabInfo,
  tabs: readonly TabInfo[],
  collapsedGroups: readonly number[] = [],
): TabInfo | undefined {
  return tabs
    .filter(
      (t) =>
        t.id !== target.id &&
        !t.discarded &&
        !(t.groupId !== undefined && collapsedGroups.includes(t.groupId)),
    )
    .sort((a, b) => Math.abs(a.index - target.index) - Math.abs(b.index - target.index))[0];
}

/** The part of the capturer the service worker also calls on startup. */
export interface TabCapturer {
  capture: (tabId: number, signal?: AbortSignal) => Promise<CaptureOutcome>;
  /** Finishes undoing a swap a previous service worker left behind (it died mid-capture). */
  recover: () => Promise<void>;
}

export function createTabCapturer(deps: OffscreenDeps): TabCapturer {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;

  /**
   * Undoes a swap without fighting the user: the target is reactivated only if the stand-in (or
   * the temporary tab) is still the active tab, and the temporary tab is removed only if it is
   * still an unused about:blank tab. If the user switched to it or navigated it, it stays.
   */
  const undoSwap = async (rec: SwapRecord) => {
    const tabs = await deps.tabsInWindow(rec.windowId).catch((): TabInfo[] => []);
    const isTemp = (t: TabInfo) =>
      rec.blankId !== undefined ? t.id === rec.blankId : !rec.knownTabIds.includes(t.id!);
    const unused = (t: TabInfo) => isTemp(t) && t.url === 'about:blank';
    const active = tabs.find((t) => t.active);
    let reactivated = false;
    if (active && (active.id === rec.standInId || unused(active))) {
      reactivated = await deps.activate(rec.targetId).then(
        () => true,
        () => false,
      );
    }
    for (const t of tabs.filter(unused)) {
      if (!t.active || reactivated) await deps.removeTab(t.id!).catch(() => {});
    }
    await deps.saveSwap(undefined).catch(() => {});
  };

  /**
   * A minimized window never draws its active tab, so its screenshot times out. Show another tab
   * there instead (invisible to the user, since the window is minimized) so the target becomes a
   * background tab, which Chrome draws offscreen. The swap is saved first, so it can be undone
   * after a crash. Returns the undo.
   */
  const swapOut = async (tab: TabInfo & { id: number }): Promise<() => Promise<void>> => {
    const [tabs, collapsed] = await Promise.all([
      deps.tabsInWindow(tab.windowId),
      deps.collapsedGroups(tab.windowId),
    ]);
    const standIn = pickStandIn(tab, tabs, collapsed);
    const rec: SwapRecord = {
      windowId: tab.windowId,
      targetId: tab.id,
      standInId: standIn?.id,
      knownTabIds: tabs.flatMap((t) => (t.id === undefined ? [] : [t.id])),
      at: now(),
    };
    await deps.saveSwap(rec);
    const undo = () => undoSwap(rec);
    try {
      if (standIn?.id !== undefined) await deps.activate(standIn.id);
      else {
        rec.blankId = await deps.createBlankTab(tab.windowId);
        await deps.saveSwap(rec);
      }
    } catch (err) {
      await undo();
      throw err;
    }
    return undo;
  };

  const attempt = async (tabId: number, signal?: AbortSignal): Promise<CaptureOutcome> => {
    if (!(await deps.hasPermission())) return 'skipped:no-permission';
    const tab = await deps.getTab(tabId);
    if (tab.id === undefined) return 'skipped:no-tab';
    if (tab.incognito) return 'skipped:incognito';
    // Attaching the debugger to a discarded (sleeping) tab would reload it.
    if (tab.discarded) return 'skipped:discarded';
    if (tab.status !== 'complete') return 'skipped:not-complete';
    if (!isCapturableUrl(tab.url)) return 'skipped:not-capturable-url';
    const win = await deps.getWindow(tab.windowId);
    if (win.incognito) return 'skipped:incognito';
    if (win.type !== 'normal') return 'skipped:not-normal-window';
    if (tab.windowId === (await deps.viewWindowId())) return 'skipped:own-window';
    const minimized = win.state === 'minimized';
    // A visible tab can be captured without the debugger (and its infobar).
    if (tab.active && !minimized) return deps.captureVisible(tab.windowId);

    const target = { ...tab, id: tab.id };
    let data: string;
    const undo = tab.active ? await swapOut(target) : undefined;
    try {
      try {
        await deps.attach(tabId);
      } catch (err) {
        // e.g. another debugger (DevTools, another extension) is already attached.
        return `error:attach: ${message(err)}`;
      }
      try {
        // The queue gave up on this run while attach hung; detach (below) right away.
        if (signal?.aborted) return 'error:attach: gave up waiting';
        data = await withTimeout(deps.screenshot(tabId), timeoutMs);
      } catch (err) {
        return `error:capture: ${message(err)}`;
      } finally {
        // Detach first thing, before decoding or saving, so the infobar is up only briefly.
        await deps.detach(tabId).catch(() => {});
      }
    } finally {
      await undo?.();
    }

    // The tab may have navigated while it was captured; the shot might not be of its URL.
    const after = await deps.getTab(tabId).catch(() => undefined);
    if (after?.url !== tab.url) return 'skipped:changed-during-capture';
    let shot: Shot;
    try {
      shot = await deps.downscale(`data:image/jpeg;base64,${data}`);
    } catch (err) {
      return `error:downscale: ${message(err)}`;
    }
    try {
      await deps.save(tab.url!, { capturedAt: now(), ...shot });
    } catch (err) {
      return `error:save: ${message(err)}`;
    }
    return 'saved';
  };

  return {
    async capture(tabId, signal) {
      // Re-hovering a tab that just failed (e.g. DevTools is attached to it) reuses the failure
      // instead of attaching again.
      const prev = await deps.previousOutcome(tabId).catch(() => undefined);
      if (prev?.outcome.startsWith('error:') && now() - prev.at < FAILURE_COOLDOWN_MS) {
        return prev.outcome;
      }
      const outcome = await attempt(tabId, signal).catch(
        (err): CaptureOutcome => `error:${message(err)}`,
      );
      await deps.record(tabId, outcome).catch(() => {});
      return outcome;
    },
    async recover() {
      const rec = await deps.loadSwap().catch(() => undefined);
      if (rec) await undoSwap(rec);
    },
  };
}

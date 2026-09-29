// On-demand screenshots of background tabs, for the hover card. captureVisibleTab can only see a
// window's visible tab, but the DevTools protocol's Page.captureScreenshot draws a background tab
// offscreen. Attaching the debugger shows Chrome's "started debugging this browser" infobar, so
// the debugger is attached only for the screenshot itself and detached before anything else.
// Chrome and the store are injected so the skip rules, the detach ordering, and the minimized-
// window swap are unit-testable.
import type { CaptureOutcome } from '../shared/captureOutcomes';
import { isCapturableUrl } from '../shared/previewPolicy';
import { message, type Shot } from './captureWindow';

type TabInfo = Pick<
  chrome.tabs.Tab,
  'id' | 'windowId' | 'index' | 'url' | 'status' | 'incognito' | 'discarded' | 'active'
>;
type WindowInfo = Pick<chrome.windows.Window, 'type' | 'state' | 'incognito'>;

export interface OffscreenDeps {
  /** The `debugger` permission and `<all_urls>` host access. */
  hasPermission: () => Promise<boolean>;
  getTab: (tabId: number) => Promise<TabInfo>;
  getWindow: (windowId: number) => Promise<WindowInfo>;
  viewWindowId: () => Promise<number | undefined>; // Tab Hammer's own window
  tabsInWindow: (windowId: number) => Promise<TabInfo[]>;
  activate: (tabId: number) => Promise<void>;
  /** Opens an active about:blank tab in the window and returns its ID. */
  createBlankTab: (windowId: number) => Promise<number>;
  removeTab: (tabId: number) => Promise<void>;
  attach: (tabId: number) => Promise<void>;
  detach: (tabId: number) => Promise<void>;
  /** CDP Page.captureScreenshot; resolves with base64 JPEG data. */
  screenshot: (tabId: number) => Promise<string>;
  /** Captures a window's visible tab the usual way (captureVisibleTab), no infobar. */
  captureVisible: (windowId: number) => Promise<CaptureOutcome>;
  downscale: (dataUrl: string) => Promise<Shot>;
  save: (url: string, shot: Shot & { capturedAt: number }) => Promise<void>;
  /** Records the attempt's outcome for the tab's hover card. Failures are ignored. */
  record: (tabId: number, outcome: CaptureOutcome) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export const SCREENSHOT_TIMEOUT_MS = 5000;

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
 * not discarded (activating a discarded tab would reload it). Undefined if there is none.
 */
export function pickStandIn(target: TabInfo, tabs: readonly TabInfo[]): TabInfo | undefined {
  return tabs
    .filter((t) => t.id !== target.id && !t.discarded)
    .sort((a, b) => Math.abs(a.index - target.index) - Math.abs(b.index - target.index))[0];
}

export function createTabCapturer(deps: OffscreenDeps): (tabId: number) => Promise<CaptureOutcome> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;

  /**
   * A minimized window never draws its active tab, so its screenshot times out. Show another tab
   * there instead (invisible to the user, since the window is minimized) so the target becomes a
   * background tab, which Chrome draws offscreen. Returns the undo.
   */
  const swapOut = async (tab: TabInfo & { id: number }): Promise<() => Promise<void>> => {
    const standIn = pickStandIn(tab, await deps.tabsInWindow(tab.windowId));
    let blankId: number | undefined;
    if (standIn?.id !== undefined) await deps.activate(standIn.id);
    else blankId = await deps.createBlankTab(tab.windowId);
    return async () => {
      await deps.activate(tab.id).catch(() => {});
      if (blankId !== undefined) await deps.removeTab(blankId).catch(() => {});
    };
  };

  const attempt = async (tabId: number): Promise<CaptureOutcome> => {
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
    const undoSwap = tab.active ? await swapOut(target) : undefined;
    try {
      try {
        await deps.attach(tabId);
      } catch (err) {
        // e.g. another debugger (DevTools, another extension) is already attached.
        return `error:attach: ${message(err)}`;
      }
      try {
        data = await withTimeout(deps.screenshot(tabId), timeoutMs);
      } catch (err) {
        return `error:capture: ${message(err)}`;
      } finally {
        // Detach first thing, before decoding or saving, so the infobar is up only briefly.
        await deps.detach(tabId).catch(() => {});
      }
    } finally {
      await undoSwap?.();
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

  return async (tabId) => {
    const outcome = await attempt(tabId).catch((err): CaptureOutcome => `error:${message(err)}`);
    await deps.record(tabId, outcome).catch(() => {});
    return outcome;
  };
}

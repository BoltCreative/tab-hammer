import { limitMs } from '../shared/e2eBuild';
import { VIEW_PING } from '../shared/viewPing';

/**
 * Keeps exactly one Tab Hammer window, across extension reloads (the dev loop reloads on every
 * build switch or dev-server restart). Two things go wrong on a reload:
 *
 * - chrome.storage.session is wiped, so anything remembered there is gone.
 * - While the old build is unloaded, Chrome navigates its pages to the New Tab page, so the
 *   window no longer shows Tab Hammer's URL ("orphaned").
 *
 * So the window is found by its URL when it still shows the view, and otherwise by the window ID
 * remembered in chrome.storage.local, tagged with the browser session (window IDs are only unique
 * within one browser run), then navigated back to the view.
 */

export const VIEW_PATH = 'src/view/index.html';
export const REMEMBERED_KEY = 'viewWindow';
/** How long a live view gets to answer a ping before it's treated as blank and reloaded. */
const PING_TIMEOUT_MS = limitMs(1000);

export interface ViewTab {
  tabId: number;
  windowId: number;
  /** The window is Tab Hammer's, but its page was navigated away by an extension unload. */
  orphaned: boolean;
}

export interface ViewWindowDeps {
  /** Every Tab Hammer window's tab, in a stable order. */
  viewTabs: () => Promise<ViewTab[]>;
  /** Resolves true if a view page answers; false if none does (or it doesn't in time). */
  ping: () => Promise<boolean>;
  reloadTab: (tabId: number) => Promise<void>;
  /** Navigates an orphaned tab back to the view. */
  restoreTab: (tabId: number) => Promise<void>;
  focusWindow: (windowId: number) => Promise<void>;
  removeWindow: (windowId: number) => Promise<void>;
  /** Opens a new Tab Hammer window and returns its ID. */
  createWindow: () => Promise<number | undefined>;
  /** Remembers which window is Tab Hammer's, so it can be found after a reload. */
  remember: (windowId: number) => Promise<void>;
}

/**
 * Makes sure one live Tab Hammer window exists: closes extra ones, brings the survivor's page
 * back if it was orphaned or left blank, and (when `open`) focuses it or creates one if none
 * exists.
 */
export async function ensureViewWindow(deps: ViewWindowDeps, open: boolean): Promise<void> {
  const tabs = await deps.viewTabs();
  // Prefer a window still showing the view over an orphaned one.
  const keep = tabs.find((t) => !t.orphaned) ?? tabs[0];
  if (!keep) {
    if (!open) return;
    const windowId = await deps.createWindow();
    if (windowId !== undefined) await deps.remember(windowId);
    return;
  }
  const extraWindows = new Set(tabs.map((t) => t.windowId).filter((id) => id !== keep.windowId));
  for (const id of extraWindows) await deps.removeWindow(id).catch(() => undefined);
  await deps.remember(keep.windowId);
  if (keep.orphaned) await deps.restoreTab(keep.tabId);
  else if (!(await deps.ping())) await deps.reloadTab(keep.tabId);
  if (open) await deps.focusWindow(keep.windowId);
}

interface Remembered {
  windowId: number;
  browserSession: string;
}

function isRemembered(v: unknown): v is Remembered {
  const r = v as Partial<Remembered> | null;
  return typeof r?.windowId === 'number' && typeof r.browserSession === 'string';
}

export function viewUrl(): string {
  return chrome.runtime.getURL(VIEW_PATH);
}

export function createViewWindowFinder(browserSession: () => Promise<string>) {
  async function viewTabs(): Promise<ViewTab[]> {
    const url = viewUrl();
    const popups = await chrome.tabs.query({ windowType: 'popup' });
    const showing = popups
      // A tab still loading reports url '' (not undefined), so fall through to its pending URL.
      .filter((t) => (t.url || t.pendingUrl || '').startsWith(url))
      .flatMap((t) =>
        t.id === undefined ? [] : [{ tabId: t.id, windowId: t.windowId, orphaned: false }],
      )
      .sort((a, b) => a.windowId - b.windowId);
    const orphan = await rememberedOrphan(popups, showing);
    return orphan ? [...showing, orphan] : showing;
  }

  /** The remembered window, if it's a one-tab popup from this browser run not showing the view. */
  async function rememberedOrphan(
    popups: chrome.tabs.Tab[],
    showing: ViewTab[],
  ): Promise<ViewTab | undefined> {
    const { [REMEMBERED_KEY]: remembered } = await chrome.storage.local.get(REMEMBERED_KEY);
    if (!isRemembered(remembered)) return undefined;
    if (showing.some((t) => t.windowId === remembered.windowId)) return undefined;
    const inWindow = popups.filter((t) => t.windowId === remembered.windowId);
    if (inWindow.length !== 1 || inWindow[0]!.id === undefined) return undefined;
    if (remembered.browserSession !== (await browserSession())) return undefined;
    return { tabId: inWindow[0]!.id, windowId: remembered.windowId, orphaned: true };
  }

  return {
    viewTabs,
    /** Tab Hammer's own window, if one is open and showing the view. */
    async viewWindowId(): Promise<number | undefined> {
      return (await viewTabs()).find((t) => !t.orphaned)?.windowId;
    },
    async remember(windowId: number): Promise<void> {
      await chrome.storage.local.set({
        [REMEMBERED_KEY]: { windowId, browserSession: await browserSession() },
      });
    },
  };
}

export function pingView(): Promise<boolean> {
  const answer = chrome.runtime
    .sendMessage({ type: VIEW_PING })
    .then((reply: unknown) => reply === true)
    .catch(() => false);
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), PING_TIMEOUT_MS));
  return Promise.race([answer, timeout]);
}

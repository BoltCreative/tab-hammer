import { VIEW_PING } from '../shared/viewPing';

/**
 * Keeps exactly one Tab Hammer window. The window is found by its page URL rather than a stored
 * window ID: chrome.storage.session is wiped whenever the extension reloads (the dev loop does
 * this on every build switch), so a stored ID is lost exactly when the old window is left behind.
 */

export const VIEW_PATH = 'src/view/index.html';
/** How long a live view gets to answer a ping before it's treated as blank and reloaded. */
const PING_TIMEOUT_MS = 1000;

export interface ViewTab {
  tabId: number;
  windowId: number;
}

export interface ViewWindowDeps {
  /** Every tab showing the view, in a stable order. */
  viewTabs: () => Promise<ViewTab[]>;
  /** Resolves true if a view page answers; false if none does (or it doesn't in time). */
  ping: () => Promise<boolean>;
  reloadTab: (tabId: number) => Promise<void>;
  focusWindow: (windowId: number) => Promise<void>;
  removeWindow: (windowId: number) => Promise<void>;
  createWindow: () => Promise<void>;
}

/**
 * Makes sure one live Tab Hammer window exists: closes extra ones, reloads the survivor if its
 * page is blank, and (when `open`) focuses it or creates one if none exists.
 */
export async function ensureViewWindow(deps: ViewWindowDeps, open: boolean): Promise<void> {
  const tabs = await deps.viewTabs();
  const [keep] = tabs;
  if (!keep) {
    if (open) await deps.createWindow();
    return;
  }
  const extraWindows = new Set(tabs.map((t) => t.windowId).filter((id) => id !== keep.windowId));
  for (const id of extraWindows) await deps.removeWindow(id).catch(() => undefined);
  if (!(await deps.ping())) await deps.reloadTab(keep.tabId);
  if (open) await deps.focusWindow(keep.windowId);
}

export function viewUrl(): string {
  return chrome.runtime.getURL(VIEW_PATH);
}

export async function viewTabs(): Promise<ViewTab[]> {
  const url = viewUrl();
  const tabs = await chrome.tabs.query({ windowType: 'popup' });
  return tabs
    .filter((t) => (t.url ?? t.pendingUrl ?? '').startsWith(url))
    .flatMap((t) => (t.id === undefined ? [] : [{ tabId: t.id, windowId: t.windowId }]))
    .sort((a, b) => a.windowId - b.windowId);
}

/** Tab Hammer's own window, if one is open. */
export async function viewWindowId(): Promise<number | undefined> {
  return (await viewTabs())[0]?.windowId;
}

export function pingView(): Promise<boolean> {
  const answer = chrome.runtime
    .sendMessage({ type: VIEW_PING })
    .then((reply: unknown) => reply === true)
    .catch(() => false);
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), PING_TIMEOUT_MS));
  return Promise.race([answer, timeout]);
}

import type { WindowRec } from '../model/outline/types';
import {
  isMissingPanelsRequest,
  loadPanelOpensIn,
  isSetViewModeRequest,
  PANEL_PORT,
  readViewMode,
  SIDE_PANEL_SETTINGS_URL,
  VIEW_MODE_KEY,
  type MissingPanelsReply,
  type PanelHello,
  type ViewMode,
} from '../shared/viewMode';

/**
 * Docked mode: the outline in Chrome's side panel in every browser window, instead of the
 * standalone window. Chrome lets only a page holding the user's click open a panel, so the
 * view opens them (the dock button, and any click in a docked panel for windows still without
 * one), and this side keeps the rest:
 *
 * - the mode, remembered in chrome.storage.local, and the toolbar icon following it: docked, Chrome
 *   itself opens the panel in the clicked window (openPanelOnActionClick, so action.onClicked
 *   doesn't fire); floating, the click opens the standalone window.
 * - which windows show a panel (each docked panel holds a port open) and which ones the user
 *   closed it in, so a click elsewhere doesn't reopen it there. Those are kept in
 *   chrome.storage.local by the windows' Tab Hammer IDs, so they outlive a browser restart (a
 *   restored window is re-linked to its record), and forgotten once a window leaves the outline
 *   for good, or the mode changes.
 * - with the panel set to open only where the user opens it (PANEL_OPENS_IN_KEY), no click in a
 *   panel opens it anywhere else.
 */

const DECLINED_KEY = 'dockDeclined';
const PANEL_SIDE_MENU_ID = 'panelSide';

export interface DockDeps {
  /** Opens (or focuses) the standalone Tab Hammer window. */
  openStandalone: () => Promise<void>;
  /** Closes the standalone Tab Hammer window, if one is open. */
  closeStandalone: () => Promise<void>;
  /** A docked panel connected (the toolbar's other job: waking the Claude bridge). */
  onPanelConnect: () => void;
  /** The outline's window records (live, hibernated, and trashed), once its queued work is done. */
  outlineWindows: () => Promise<WindowRec[]>;
}

export function registerDock(deps: DockDeps): {
  mode: () => Promise<ViewMode>;
  /** Browser windows whose docked panel is connected (a test hook). */
  panelWindows: () => number[];
} {
  const panels = new Map<chrome.runtime.Port, number>();

  const applyToolbar = (mode: ViewMode) =>
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: mode === 'dock' })
      .catch((err: unknown) => console.error('[dock] setPanelBehavior', err));

  /** The stored declined windows' Tab Hammer IDs, less those the outline no longer holds. */
  async function storedDeclined(windows: WindowRec[]): Promise<Set<string>> {
    const { [DECLINED_KEY]: stored } = await chrome.storage.local.get(DECLINED_KEY);
    const known = new Set(windows.map((w) => w.id));
    return new Set(
      (Array.isArray(stored) ? stored : []).filter(
        (id): id is string => typeof id === 'string' && known.has(id),
      ),
    );
  }
  /** The Chrome window IDs of the open windows the user closed the panel in. */
  async function declinedChromeIds(): Promise<Set<number>> {
    const windows = await deps.outlineWindows();
    const ids = await storedDeclined(windows);
    return new Set(
      windows.flatMap((w) =>
        ids.has(w.id) && w.state === 'live' && w.chromeWindowId !== undefined
          ? [w.chromeWindowId]
          : [],
      ),
    );
  }
  // Changes to the declined list run one at a time, so two can't read the same list and lose one.
  let declinedQueue: Promise<unknown> = Promise.resolve();
  /** Marks (or unmarks) the window shown in Chrome window `windowId` as declined. */
  function setDeclined(windowId: number, on: boolean): Promise<void> {
    const run = declinedQueue.then(async () => {
      const windows = await deps.outlineWindows();
      const rec = windows.find((w) => w.state === 'live' && w.chromeWindowId === windowId);
      const ids = await storedDeclined(windows);
      if (rec) {
        if (on) ids.add(rec.id);
        else ids.delete(rec.id);
      }
      await chrome.storage.local.set({ [DECLINED_KEY]: [...ids] });
    });
    declinedQueue = run.catch(() => undefined);
    return run;
  }

  async function setMode(mode: ViewMode): Promise<void> {
    await chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
    const cleared = declinedQueue.then(() => chrome.storage.local.remove(DECLINED_KEY));
    declinedQueue = cleared.catch(() => undefined);
    await cleared;
    await applyToolbar(mode);
    if (mode === 'dock') {
      await deps.closeStandalone();
      return;
    }
    // Floating: the window first, so the outline never vanishes, then every window's panel.
    // Closing needs no click (Chrome 141+); a window without a panel is a no-op.
    await deps.openStandalone();
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await Promise.all(
      windows.map((w) =>
        w.id === undefined
          ? undefined
          : chrome.sidePanel?.close?.({ windowId: w.id }).catch(() => undefined),
      ),
    );
  }

  async function missingPanels(): Promise<number[]> {
    if ((await readViewMode()) !== 'dock' || (await loadPanelOpensIn()) !== 'every') return [];
    const showing = new Set(panels.values());
    const skip = await declinedChromeIds();
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return windows.flatMap((w) =>
      w.id === undefined || showing.has(w.id) || skip.has(w.id) ? [] : [w.id],
    );
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    port.onMessage.addListener((msg: unknown) => {
      const windowId = (msg as Partial<PanelHello> | null)?.windowId;
      if (typeof windowId !== 'number') return;
      panels.set(port, windowId);
      void setDeclined(windowId, false).catch((err: unknown) =>
        console.error('[dock] forgetting a closed panel', err),
      );
      deps.onPanelConnect();
    });
    port.onDisconnect.addListener(() => {
      const windowId = panels.get(port);
      panels.delete(port);
      if (windowId === undefined) return;
      // The user closed this window's panel (not the whole window, and not by leaving docked
      // mode): leave it closed there.
      void (async () => {
        if ((await readViewMode()) !== 'dock') return;
        const windowGone = await chrome.windows.get(windowId).then(
          () => false,
          () => true,
        );
        if (!windowGone) await setDeclined(windowId, true);
      })().catch((err: unknown) => console.error('[dock] remembering a closed panel', err));
    });
  });

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (isSetViewModeRequest(msg)) {
      setMode(msg.mode).then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ ok: false, error: String(err) }),
      );
      return true;
    }
    if (isMissingPanelsRequest(msg)) {
      missingPanels().then(
        (windowIds) => sendResponse({ windowIds } satisfies MissingPanelsReply),
        () => sendResponse({ windowIds: [] } satisfies MissingPanelsReply),
      );
      return true;
    }
    return false;
  });

  // The toolbar icon's right-click menu: Chrome lets extensions read the side panel's side but not
  // set it, so this opens the setting. Menu items persist, so they're (re)made on install/update.
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: PANEL_SIDE_MENU_ID,
        title: 'Side panel: left or right…',
        contexts: ['action'],
      });
    });
  });
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === PANEL_SIDE_MENU_ID) {
      void chrome.tabs.create({ url: SIDE_PANEL_SETTINGS_URL });
    }
  });

  // Chrome keeps the panel behavior, but re-assert it in case the stored mode and Chrome disagree
  // (an older build, or a wiped profile setting).
  void readViewMode().then(applyToolbar);

  return { mode: readViewMode, panelWindows: () => [...new Set(panels.values())].sort() };
}

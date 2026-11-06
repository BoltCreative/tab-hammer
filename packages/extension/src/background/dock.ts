import {
  isMissingPanelsRequest,
  isSetViewModeRequest,
  PANEL_PORT,
  readViewMode,
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
 *   closed it in, so a click elsewhere doesn't reopen it there. Kept in chrome.storage.session to
 *   outlive a worker restart; a browser restart forgets them.
 */

const DECLINED_KEY = 'dockDeclined';

export interface DockDeps {
  /** Opens (or focuses) the standalone Tab Hammer window. */
  openStandalone: () => Promise<void>;
  /** Closes the standalone Tab Hammer window, if one is open. */
  closeStandalone: () => Promise<void>;
  /** A docked panel connected (the toolbar's other job: waking the Claude bridge). */
  onPanelConnect: () => void;
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

  async function declined(): Promise<Set<number>> {
    const { [DECLINED_KEY]: ids } = await chrome.storage.session.get(DECLINED_KEY);
    return new Set(Array.isArray(ids) ? (ids as number[]) : []);
  }
  async function updateDeclined(change: (ids: Set<number>) => void): Promise<void> {
    const ids = await declined();
    change(ids);
    await chrome.storage.session.set({ [DECLINED_KEY]: [...ids] });
  }

  async function setMode(mode: ViewMode): Promise<void> {
    await chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
    await chrome.storage.session.remove(DECLINED_KEY);
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
    if ((await readViewMode()) !== 'dock') return [];
    const showing = new Set(panels.values());
    const skip = await declined();
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
      void updateDeclined((ids) => ids.delete(windowId));
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
        if (!windowGone) await updateDeclined((ids) => ids.add(windowId));
      })();
    });
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void updateDeclined((ids) => ids.delete(windowId));
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

  // Chrome keeps the panel behavior, but re-assert it in case the stored mode and Chrome disagree
  // (an older build, or a wiped profile setting).
  void readViewMode().then(applyToolbar);

  return { mode: readViewMode, panelWindows: () => [...new Set(panels.values())].sort() };
}

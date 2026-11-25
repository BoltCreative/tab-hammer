// The view's side of docked mode (the service worker's is src/background/dock.ts): opening Chrome's
// side panel, which only a page holding the user's click may do, and switching modes.
import { useCallback, useEffect, useState } from 'react';
import { E2E_BUILD } from '../../shared/e2eBuild';
import {
  loadPanelOpensIn,
  MISSING_PANELS,
  PANEL_OPENS_IN_KEY,
  PANEL_PORT,
  readPanelOpensIn,
  SET_VIEW_MODE,
  SIDE_PANEL_SETTINGS_URL,
  type MissingPanelsReply,
  type PanelHello,
  type PanelOpensIn,
  type SetViewModeRequest,
  type ViewMode,
} from '../../shared/viewMode';

/** Which view this page is: the standalone window, or a docked side panel (panel.html). */
export type Surface = 'window' | 'panel';
export const surface: Surface =
  document.documentElement.dataset.surface === 'panel' ? 'panel' : 'window';

const RECONNECT_MS = 500;
/**
 * Clicks in a panel ask the worker for windows still without one at most this often. Every click
 * asks in the e2e build, so a test's click never depends on how long ago its last one was.
 */
const MISSING_CHECK_MS = E2E_BUILD ? 0 : 1000;

/**
 * Opens the panel in each window. Chrome lets a click open panels for about 5 seconds after it,
 * so they all go out at once rather than one after another.
 */
function openPanels(windowIds: number[]): Promise<unknown> {
  return Promise.allSettled(windowIds.map((windowId) => chrome.sidePanel.open({ windowId })));
}

/**
 * Docked, a window Tab Hammer just opened from a click in this panel (New window, or tabs dropped
 * for a new window) gets the panel too, while Chrome still counts that click, unless the panel
 * opens only where the user opens it. In the standalone window it does nothing.
 */
export function dockInto(windowId: number | undefined): void {
  if (surface !== 'panel' || windowId === undefined) return;
  loadPanelOpensIn()
    .then((opensIn) => (opensIn === 'every' ? chrome.sidePanel.open({ windowId }) : undefined))
    // Too late for the click: the next click in any panel opens it (registerPanel).
    .catch((err: unknown) => console.warn('Tab Hammer: docking into the new window failed', err));
}

async function setMode(mode: ViewMode): Promise<void> {
  const request: SetViewModeRequest = { type: SET_VIEW_MODE, mode };
  await chrome.runtime.sendMessage(request);
}

/**
 * The standalone window's Dock button: opens the side panel in every browser window (this click
 * is what allows it), or, with the panel opening only where the user opens it, in the window last
 * used; then the worker remembers docked mode and closes this window.
 */
export async function dockEverywhere(): Promise<void> {
  const windows =
    (await loadPanelOpensIn()) === 'every'
      ? await chrome.windows.getAll({ windowTypes: ['normal'] })
      : [await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined)];
  await openPanels(windows.flatMap((w) => (w?.id === undefined ? [] : [w.id])));
  await setMode('dock');
}

/** A panel's Pop out button: the worker opens the standalone window and closes every panel. */
export function popOut(): Promise<void> {
  return setMode('float');
}

/**
 * Runs in every docked panel. Tells the worker which window this panel is in (and keeps telling
 * it after a worker restart), and turns any click in the panel into opening the panel in the
 * browser windows that don't have one yet, e.g. ones opened since docking.
 */
export function registerPanel(): void {
  let lastCheck = 0;
  document.addEventListener(
    'pointerdown',
    (e) => {
      // Pop out is about to close every panel; don't race it by opening more.
      if ((e.target as Element | null)?.closest?.('.dock-toggle')) return;
      const now = Date.now();
      if (now - lastCheck < MISSING_CHECK_MS) return;
      lastCheck = now;
      void (chrome.runtime.sendMessage({ type: MISSING_PANELS }) as Promise<MissingPanelsReply>)
        .then((reply) => openPanels(reply?.windowIds ?? []))
        .catch((err: unknown) => console.error('Tab Hammer: opening missing panels failed', err));
    },
    true,
  );

  void (async () => {
    // panel.html opened as an ordinary tab (or by a test) isn't a docked panel.
    if (await chrome.tabs.getCurrent()) return;
    const { id: windowId } = await chrome.windows.getCurrent();
    if (windowId === undefined) return;
    const connect = () => {
      const port = chrome.runtime.connect({ name: PANEL_PORT });
      port.postMessage({ windowId } satisfies PanelHello);
      port.onDisconnect.addListener(() => setTimeout(connect, RECONNECT_MS));
    };
    connect();
  })();
}

/**
 * Which side of the browser window Chrome shows its side panel on: the user's Chrome setting,
 * which the extension can read (Chrome 140+) but not change. Read again when the panel comes back
 * into view, since there's no change event. Undefined until known, or in the standalone window.
 * Also sets `data-side` on the root element for the stylesheet.
 */
export function useSidePanelSide(): 'left' | 'right' | undefined {
  const [side, setSide] = useState<'left' | 'right' | undefined>(undefined);
  useEffect(() => {
    if (surface !== 'panel' || !chrome.sidePanel?.getLayout) return;
    let live = true;
    const read = () =>
      void chrome.sidePanel
        .getLayout()
        .then((layout) => {
          if (!live) return;
          const next = layout.side === 'left' ? 'left' : 'right';
          // On the root too, so the panel's edge styling can face the page.
          document.documentElement.dataset.side = next;
          setSide(next);
        })
        .catch(() => undefined);
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, []);
  return side;
}

/**
 * The browser window a docked panel sits in, which its outline marks and opens scrolled to. Undefined in
 * the standalone window, which sits in a window of its own. (panel.html opened as a tab, as the
 * e2e tests do, reports that tab's window.)
 */
export function useHostWindowId(): number | undefined {
  const [windowId, setWindowId] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (surface !== 'panel') return;
    let live = true;
    chrome.windows
      .getCurrent()
      .then((w) => {
        if (live) setWindowId(w.id);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return windowId;
}

/**
 * Docked, where the panel opens (every window, or only where the user opens it), remembered in
 * chrome.storage.local and followed live by every view. The worker reads it when a panel asks for
 * the windows still without one.
 */
export function usePanelOpensIn(): [PanelOpensIn, (next: PanelOpensIn) => void] {
  const [value, setValue] = useState<PanelOpensIn>(() => readPanelOpensIn(undefined));
  useEffect(() => {
    let live = true;
    loadPanelOpensIn()
      .then((v) => {
        if (live) setValue(v);
      })
      .catch((err: unknown) => console.error('Tab Hammer: reading panel setting failed', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && PANEL_OPENS_IN_KEY in changes) {
        setValue(readPanelOpensIn(changes[PANEL_OPENS_IN_KEY]!.newValue));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  const set = useCallback((next: PanelOpensIn) => {
    setValue(next);
    chrome.storage.local
      .set({ [PANEL_OPENS_IN_KEY]: next })
      .catch((err: unknown) => console.error('Tab Hammer: saving panel setting failed', err));
  }, []);
  return [value, set];
}

export function openSidePanelSettings(): void {
  void chrome.tabs.create({ url: SIDE_PANEL_SETTINGS_URL });
}

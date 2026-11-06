// The view's side of docked mode (the service worker's is src/background/dock.ts): opening Chrome's
// side panel, which only a page holding the user's click may do, and switching modes.
import { useEffect, useState } from 'react';
import {
  MISSING_PANELS,
  PANEL_PORT,
  SET_VIEW_MODE,
  SIDE_PANEL_SETTINGS_URL,
  type MissingPanelsReply,
  type PanelHello,
  type SetViewModeRequest,
  type ViewMode,
} from '../../shared/viewMode';

/** Which view this page is: the standalone window, or a docked side panel (panel.html). */
export type Surface = 'window' | 'panel';
export const surface: Surface =
  document.documentElement.dataset.surface === 'panel' ? 'panel' : 'window';

const RECONNECT_MS = 500;
/** Clicks in a panel ask the worker for windows still without one at most this often. */
const MISSING_CHECK_MS = 1000;

/**
 * Opens the panel in each window. Chrome lets a click open panels for about 5 seconds after it,
 * so they all go out at once rather than one after another.
 */
function openPanels(windowIds: number[]): Promise<unknown> {
  return Promise.allSettled(windowIds.map((windowId) => chrome.sidePanel.open({ windowId })));
}

async function setMode(mode: ViewMode): Promise<void> {
  const request: SetViewModeRequest = { type: SET_VIEW_MODE, mode };
  await chrome.runtime.sendMessage(request);
}

/**
 * The standalone window's Dock button: opens the side panel in every browser window (this click
 * is what allows it), then the worker remembers docked mode and closes this window.
 */
export async function dockEverywhere(): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  await openPanels(windows.flatMap((w) => (w.id === undefined ? [] : [w.id])));
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
 * The browser window a docked panel sits in, which its outline lists first and marks. Undefined in
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

export function openSidePanelSettings(): void {
  void chrome.tabs.create({ url: SIDE_PANEL_SETTINGS_URL });
}

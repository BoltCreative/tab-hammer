// Where the Tab Hammer view lives: its own standalone window ('float'), or Chrome's side panel in
// every browser window ('dock'). Remembered in chrome.storage.local; the service worker makes the
// toolbar icon follow it.

export type ViewMode = 'float' | 'dock';
export const VIEW_MODE_KEY = 'viewMode';
export const DEFAULT_VIEW_MODE: ViewMode = 'float';

export function isViewMode(v: unknown): v is ViewMode {
  return v === 'float' || v === 'dock';
}

export async function readViewMode(): Promise<ViewMode> {
  const { [VIEW_MODE_KEY]: stored } = await chrome.storage.local.get(VIEW_MODE_KEY);
  return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
}

/**
 * View → service worker: switch modes. The view opens the side panels itself before docking (only
 * a page holding the user's click may call sidePanel.open); the worker remembers the mode, points
 * the toolbar icon at it, and closes whatever the old mode showed.
 */
export const SET_VIEW_MODE = 'tabHammer.setViewMode' as const;
export interface SetViewModeRequest {
  type: typeof SET_VIEW_MODE;
  mode: ViewMode;
}

export function isSetViewModeRequest(msg: unknown): msg is SetViewModeRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === SET_VIEW_MODE &&
    isViewMode((msg as { mode?: unknown }).mode)
  );
}

/**
 * Docked panel → service worker, on a click in the panel: which browser windows should get a panel
 * now. Those without one, less those where the user closed it; empty unless docked.
 */
export const MISSING_PANELS = 'tabHammer.missingPanels' as const;
export interface MissingPanelsRequest {
  type: typeof MISSING_PANELS;
}
export interface MissingPanelsReply {
  windowIds: number[];
}

export function isMissingPanelsRequest(msg: unknown): msg is MissingPanelsRequest {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === MISSING_PANELS
  );
}

/** Each docked panel holds this port open, after posting its browser window's ID. */
export const PANEL_PORT = 'tabHammer.panel';
export interface PanelHello {
  windowId: number;
}

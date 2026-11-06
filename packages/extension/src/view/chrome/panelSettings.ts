// The preview panel's remembered layout: expanded or collapsed, and its height. Kept in
// chrome.storage.local (not the page's own storage) so it survives closing and reopening the
// Tab Hammer window and extension reloads.

export const PANEL_SETTINGS_KEY = 'previewPanel';

export interface PanelSettings {
  expanded: boolean;
  height: number; // px, of the expanded panel including its header bar
}

export const DEFAULT_PANEL_SETTINGS: PanelSettings = { expanded: true, height: 260 };

export async function loadPanelSettings(): Promise<PanelSettings> {
  const stored = (await chrome.storage.local.get(PANEL_SETTINGS_KEY))[PANEL_SETTINGS_KEY] as
    Partial<PanelSettings> | undefined;
  return {
    expanded:
      typeof stored?.expanded === 'boolean' ? stored.expanded : DEFAULT_PANEL_SETTINGS.expanded,
    height:
      typeof stored?.height === 'number' && stored.height > 0
        ? stored.height
        : DEFAULT_PANEL_SETTINGS.height,
  };
}

export function savePanelSettings(s: PanelSettings): Promise<void> {
  return chrome.storage.local.set({ [PANEL_SETTINGS_KEY]: s });
}

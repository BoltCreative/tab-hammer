import type { WindowRec } from '../model/outline/types';
import type { OutlineCommand } from '../shared/outlineMessages';
import { getPreview } from '../shared/previewStore';
import { connectBridge } from './bridge';
import { registerOutline } from './outline/outlineOwner';
import { OUTLINE_SCHEMA_VERSION, exportOutline, type SyncWindow } from './outline/outlineStore';
import { registerPreviewCapture, viewWindows } from './previews';
import { setWindowCreator } from './tabCommands';
import { openingBounds, trackViewBounds } from './viewBounds';
import { ensureViewWindow, pingView, viewUrl, type ViewWindowDeps } from './viewWindow';

const viewWindowDeps: ViewWindowDeps = {
  viewTabs: viewWindows.viewTabs,
  ping: pingView,
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
  restoreTab: async (tabId) => void (await chrome.tabs.update(tabId, { url: viewUrl() })),
  focusWindow: async (windowId) => void (await chrome.windows.update(windowId, { focused: true })),
  removeWindow: (windowId) => chrome.windows.remove(windowId),
  createWindow: async () =>
    (
      await chrome.windows.create({
        url: viewUrl(),
        type: 'popup',
        ...(await openingBounds()),
      })
    )?.id,
  remember: viewWindows.remember,
};

async function openOrFocus(): Promise<void> {
  await ensureViewWindow(viewWindowDeps, true);
}

chrome.action.onClicked.addListener(() => {
  connectBridge();
  void openOrFocus();
});
registerPreviewCapture();
const outline = registerOutline();
setWindowCreator((data) => outline.openWindow(() => chrome.windows.create(data)));
trackViewBounds(viewWindows.viewWindowId);
// An extension reload (the dev loop's build switch or dev-server restart) orphans the view window
// on a New Tab page, or leaves it blank: bring it back in place without stealing focus.
chrome.runtime.onInstalled.addListener(() => void ensureViewWindow(viewWindowDeps, false));
connectBridge();

// Test hooks: Playwright can't click the toolbar icon, so E2E calls openOrFocus directly, and
// waits on hasPreview for a background capture to land in the store. readOutline returns the
// worker's full in-memory records (Chrome IDs included) once its queued work is done.
export interface TestHooks {
  openOrFocus: () => Promise<void>;
  hasPreview: (url: string) => Promise<boolean>;
  readOutline: () => Promise<{ schemaVersion: number; windows: WindowRec[] }>;
  syncExport: () => Promise<{ schemaVersion: number; windows: SyncWindow[] }>;
  outlineCommand: (c: OutlineCommand) => Promise<void>;
}
(globalThis as unknown as { tabHammer: TestHooks }).tabHammer = {
  openOrFocus,
  hasPreview: async (url) => (await getPreview(url)) !== undefined,
  readOutline: async () => {
    await outline.idle();
    return { schemaVersion: OUTLINE_SCHEMA_VERSION, windows: outline.outline().windows };
  },
  syncExport: exportOutline,
  outlineCommand: (c) => outline.command(c),
};

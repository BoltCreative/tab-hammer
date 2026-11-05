import type { WindowRec } from '../model/outline/types';
import type { OutlineCommand } from '../shared/outlineMessages';
import { getPreview } from '../shared/previewStore';
import { connectBridge } from './bridge';
import { registerOutline } from './outline/outlineOwner';
import { OUTLINE_SCHEMA_VERSION } from './outline/outlineStore';
import { registerPreviewCapture, viewWindows } from './previews';
import { registerSync } from './sync/registerSync';
import type { SyncPickerState } from '../shared/syncMessages';
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
// The sync engine hears about every saved outline change, to push it to Drive. (Saves are async,
// so the first change arrives after syncHandle is set.)
const outline = registerOutline({ onChange: () => syncHandle.noteChange() });
const syncHandle = registerSync(outline);
setWindowCreator((data) => outline.openWindow(() => chrome.windows.create(data)));
trackViewBounds(viewWindows.viewWindowId);
// An extension reload (the dev loop's build switch or dev-server restart) orphans the view window
// on a New Tab page, or leaves it blank: bring it back in place without stealing focus.
chrome.runtime.onInstalled.addListener(() => void ensureViewWindow(viewWindowDeps, false));
connectBridge();

// Test hooks: Playwright can't click the toolbar icon, so E2E calls openOrFocus directly, and
// waits on hasPreview for a background capture to land in the store. readOutline returns the
// worker's full in-memory records (Chrome IDs included) once its queued work is done. useTestSync,
// syncNow, and syncState drive the sync engine against a test-served fake Drive.
export interface TestHooks {
  openOrFocus: () => Promise<void>;
  hasPreview: (url: string) => Promise<boolean>;
  readOutline: () => Promise<{ schemaVersion: number; windows: WindowRec[] }>;
  outlineCommand: (c: OutlineCommand) => Promise<void>;
  useTestSync: (opts: { apiBase: string; token: string }) => Promise<void>;
  syncNow: () => Promise<void>;
  syncState: () => Promise<SyncPickerState>;
}
(globalThis as unknown as { tabHammer: TestHooks }).tabHammer = {
  openOrFocus,
  hasPreview: async (url) => (await getPreview(url)) !== undefined,
  readOutline: async () => {
    await outline.idle();
    return { schemaVersion: OUTLINE_SCHEMA_VERSION, windows: outline.outline().windows };
  },
  outlineCommand: (c) => outline.command(c),
  // Points sync at a fake Drive served by the test (never Google), then syncs.
  useTestSync: async ({ apiBase, token }) => {
    syncHandle.useTestBackend(apiBase, token);
    await syncHandle.engine.sync();
  },
  // Pushes now (no 10s wait) once the outline's queued changes are saved, then pulls.
  syncNow: async () => {
    await outline.idle();
    await syncHandle.engine.flushNow();
    await syncHandle.engine.sync();
  },
  syncState: () => syncHandle.engine.pickerState(),
};

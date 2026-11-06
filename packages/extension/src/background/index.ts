import type { WindowRec } from '../model/outline/types';
import type { OutlineCommand } from '../shared/outlineMessages';
import { getPreview } from '../shared/previewStore';
import { connectBridge } from './bridge';
import { registerDock } from './dock';
import { registerOutline } from './outline/outlineOwner';
import { OUTLINE_SCHEMA_VERSION } from './outline/outlineStore';
import { registerPreviewCapture, viewWindows } from './previews';
import { registerSync } from './sync/registerSync';
import { createPreviewPruner } from './previewPrune';
import { prunePreviews } from '../shared/previewStore';
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

/** Closes every standalone Tab Hammer window (docking moves the outline into the side panels). */
async function closeStandalone(): Promise<void> {
  const tabs = await viewWindows.viewTabs();
  for (const id of new Set(tabs.map((t) => t.windowId))) {
    await chrome.windows.remove(id).catch(() => undefined);
  }
}

const dock = registerDock({
  openStandalone: openOrFocus,
  closeStandalone,
  onPanelConnect: connectBridge,
});

// Docked, Chrome opens the side panel on a toolbar click itself and this doesn't fire; the mode
// check covers the moment before that behavior is applied.
chrome.action.onClicked.addListener(() => {
  connectBridge();
  void dock.mode().then((mode) => (mode === 'float' ? openOrFocus() : undefined));
});
registerPreviewCapture();
// The sync engine hears about every saved outline change, to push it to Drive. (Saves are async,
// so the first change arrives after syncHandle is set.)
const outline = registerOutline({
  onChange: () => {
    syncHandle.noteChange();
    previewPruner.schedule();
  },
});
const syncHandle = registerSync(outline);
// Previews live exactly as long as a window record (live, hibernated, or trashed) has a tab at
// their address; the outline's changes, and each worker start, prune the rest.
const previewPruner = createPreviewPruner({
  outlineWindows: () => outline.exportWindows(), // after the outline loads and settles its queue
  openUrls: async () =>
    (await chrome.tabs.query({})).flatMap(
      (t) => [t.url, t.pendingUrl].filter((u) => !!u) as string[],
    ),
  prune: prunePreviews,
  now: Date.now,
  onError: (err) => console.error('[previews] prune', err),
});
previewPruner.schedule();
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
  prunePreviews: () => Promise<void>;
  panelWindows: () => number[];
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
  // Runs the preview prune now (after the outline's queued work), for asserting what it kept.
  prunePreviews: () => previewPruner.run(),
  // Browser windows with a connected docked side panel.
  panelWindows: () => dock.panelWindows(),
};

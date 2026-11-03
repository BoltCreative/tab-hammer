import { getPreview } from '../shared/previewStore';
import { connectBridge } from './bridge';
import { registerPreviewCapture } from './previews';
import { openingBounds, trackViewBounds } from './viewBounds';
import {
  ensureViewWindow,
  pingView,
  viewTabs,
  viewUrl,
  viewWindowId,
  type ViewWindowDeps,
} from './viewWindow';

const viewWindowDeps: ViewWindowDeps = {
  viewTabs,
  ping: pingView,
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
  focusWindow: async (windowId) => void (await chrome.windows.update(windowId, { focused: true })),
  removeWindow: (windowId) => chrome.windows.remove(windowId),
  createWindow: async () =>
    void (await chrome.windows.create({
      url: viewUrl(),
      type: 'popup',
      ...(await openingBounds()),
    })),
};

async function openOrFocus(): Promise<void> {
  await ensureViewWindow(viewWindowDeps, true);
}

chrome.action.onClicked.addListener(() => {
  connectBridge();
  void openOrFocus();
});
registerPreviewCapture();
trackViewBounds(viewWindowId);
// An extension reload (the dev loop's build switch) can leave the view window blank, or leave
// one behind per reload: fix it up in place without stealing focus.
chrome.runtime.onInstalled.addListener(() => void ensureViewWindow(viewWindowDeps, false));
connectBridge();

// Test hooks: Playwright can't click the toolbar icon, so E2E calls openOrFocus directly, and
// waits on hasPreview for a background capture to land in the store.
export interface TestHooks {
  openOrFocus: () => Promise<void>;
  hasPreview: (url: string) => Promise<boolean>;
}
(globalThis as unknown as { tabHammer: TestHooks }).tabHammer = {
  openOrFocus,
  hasPreview: async (url) => (await getPreview(url)) !== undefined,
};

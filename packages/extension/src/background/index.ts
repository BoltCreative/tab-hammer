import { getPreview } from '../shared/previewStore';
import { connectBridge } from './bridge';
import { registerPreviewCapture } from './previews';

export const VIEW_PATH = 'src/view/index.html';

async function openOrFocus(): Promise<void> {
  const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
  if (typeof viewWindowId === 'number') {
    try {
      await chrome.windows.update(viewWindowId, { focused: true });
      return;
    } catch {
      // The stored window was closed; fall through and open a new one.
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(VIEW_PATH),
    type: 'popup',
    width: 420,
    height: 820,
  });
  await chrome.storage.session.set({ viewWindowId: win?.id });
}

chrome.action.onClicked.addListener(() => {
  connectBridge();
  void openOrFocus();
});
registerPreviewCapture();
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

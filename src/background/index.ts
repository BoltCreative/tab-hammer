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
  void openOrFocus();
});

// Test hook: Playwright can't click the toolbar icon, so E2E calls this directly.
(globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }).tabHammer = {
  openOrFocus,
};

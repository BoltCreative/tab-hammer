// Direct actions on live Chrome tabs and windows. The outline itself comes from the service
// worker (outlineClient.ts).
import type { MoveOp } from '../../model/moveSelection';
import { isViewPing } from '../../shared/viewPing';

/** Tells the service worker this view is alive, so it reuses the window rather than reloading it. */
export function answerPings(): void {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isViewPing(msg)) return false;
    sendResponse(true);
    return false;
  });
}

export async function activateTab(tabId: number, windowId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
}

export async function focusWindow(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
}

/** Runs a drag-move's planned Chrome calls in order (see model/moveSelection.ts). */
export async function applyMoveOps(ops: MoveOp[]): Promise<void> {
  for (const o of ops) {
    switch (o.op) {
      case 'moveTab':
        await chrome.tabs.move(o.tabId, { windowId: o.windowId, index: o.index });
        break;
      case 'moveGroup':
        await chrome.tabGroups.move(o.groupId, { windowId: o.windowId, index: o.index });
        break;
      case 'group':
        await chrome.tabs.group({ tabIds: o.tabIds as [number, ...number[]], groupId: o.groupId });
        break;
      case 'ungroup':
        await chrome.tabs.ungroup(o.tabIds as [number, ...number[]]);
        break;
      case 'moveNextTo': {
        // Read positions now: earlier calls in this plan have shifted them. A move removes the tab
        // first, so a tab left of the anchor lands one lower.
        const [tab, anchor] = await Promise.all([
          chrome.tabs.get(o.tabId),
          chrome.tabs.get(o.anchorTabId),
        ]);
        const left = tab.windowId === anchor.windowId && tab.index < anchor.index ? 1 : 0;
        const index = anchor.index - left + (o.side === 'after' ? 1 : 0);
        await chrome.tabs.move(o.tabId, { windowId: anchor.windowId, index });
        break;
      }
    }
  }
}

export async function closeTabs(tabIds: number[]): Promise<void> {
  if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
}

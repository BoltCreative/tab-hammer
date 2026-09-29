// The record of an in-progress minimized-window swap (see src/background/debuggerCapture.ts),
// kept in chrome.storage.local so a service worker that dies mid-swap can undo it on its next
// start, and so the view can hide the temporary tab instead of closing the hover card over it.

export interface SwapRecord {
  windowId: number;
  targetId: number; // the tab being captured, active before the swap
  standInId?: number; // the tab activated in its place, if one was
  blankId?: number; // the temporary about:blank tab, once created
  knownTabIds: number[]; // the window's tabs before the swap
  at: number; // ms since epoch, when the swap started
}

export const SWAP_KEY = 'captureSwap';

/** A record older than this is left over from a crash; the view stops hiding tabs for it. */
export const SWAP_MAX_AGE_MS = 30_000;

export function isSwapRecord(v: unknown): v is SwapRecord {
  const r = v as SwapRecord | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.windowId === 'number' &&
    typeof r.targetId === 'number' &&
    Array.isArray(r.knownTabIds) &&
    typeof r.at === 'number'
  );
}

/**
 * Whether the view should leave this tab out of the tree: it appeared in the swapped window after
 * the swap began, so it is (or is about to be) the temporary tab. Hiding it keeps the tree, and
 * so the hover card over it, unchanged while a capture runs.
 */
export function hiddenBySwap(
  record: SwapRecord | undefined,
  tab: { id: number; windowId: number },
  now: number,
): boolean {
  if (!record || now - record.at > SWAP_MAX_AGE_MS) return false;
  return tab.windowId === record.windowId && !record.knownTabIds.includes(tab.id);
}

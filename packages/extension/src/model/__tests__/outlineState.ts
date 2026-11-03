// Builds the worker's broadcast `OutlineState` for view-model tests, from Task 1's record helpers.
import type { WindowRec } from '../outline/types';
import type { LiveDetails, OutlineState } from '../../shared/outlineMessages';

export { group, tab, win } from '../outline/__tests__/recs';

type LiveTabDetails = LiveDetails['tabs'][number];

/**
 * An `OutlineState` holding `windows`. Every live tab (one with a `chromeTabId`) gets inactive,
 * undiscarded live details unless `live.tabs` says otherwise; no window is focused unless
 * `live.focusedWindowId` names one.
 */
export function state(s: {
  windows: WindowRec[];
  live?: { tabs?: Record<number, Partial<LiveTabDetails>>; focusedWindowId?: number | null };
}): OutlineState {
  const tabs: LiveDetails['tabs'] = {};
  for (const w of s.windows) {
    for (const t of w.tabs) {
      if (t.chromeTabId !== undefined) tabs[t.chromeTabId] = { active: false, discarded: false };
    }
  }
  for (const [id, details] of Object.entries(s.live?.tabs ?? {})) {
    tabs[Number(id)] = { active: false, discarded: false, ...tabs[Number(id)], ...details };
  }
  return {
    windows: s.windows,
    live: { tabs, focusedWindowId: s.live?.focusedWindowId ?? null },
  };
}

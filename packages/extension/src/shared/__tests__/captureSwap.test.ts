import { describe, expect, it } from 'vitest';
import { SWAP_MAX_AGE_MS, hiddenBySwap, type SwapRecord } from '../captureSwap';

describe('hiddenBySwap', () => {
  const NOW = 1_000_000;
  const rec: SwapRecord = {
    session: 's',
    windowId: 7,
    targetId: 70,
    knownTabIds: [70, 71],
    at: NOW,
  };

  it.each([
    [
      'a tab that appeared in the swapped window (the temporary tab)',
      rec,
      { id: 500, windowId: 7 },
      NOW,
      true,
    ],
    ['a tab the window already had', rec, { id: 71, windowId: 7 }, NOW, false],
    ['a new tab in another window', rec, { id: 501, windowId: 8 }, NOW, false],
    [
      'anything once the record is stale (left over from a crash)',
      rec,
      { id: 500, windowId: 7 },
      NOW + SWAP_MAX_AGE_MS + 1,
      false,
    ],
    ['anything with no swap in progress', undefined, { id: 500, windowId: 7 }, NOW, false],
  ])('%s', (_name, record, tab, now, hidden) => {
    expect(hiddenBySwap(record, tab, now)).toBe(hidden);
  });
});

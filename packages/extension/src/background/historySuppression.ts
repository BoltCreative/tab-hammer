// Pages the user removed from Chrome's history get no preview saved again until they're visited
// again. A capture already triggered (or in flight) when the history was cleared would otherwise
// finish afterwards and put the deleted page's preview straight back.
import { previewKey } from '../shared/previewPolicy';

export interface HistorySuppression {
  /** Chrome removed these pages from its history (`all`: the whole history). */
  removed(urls: readonly string[] | 'all'): void;
  /** Chrome recorded a visit to this page. */
  visited(url: string): void;
  /** A preview of this page may be saved. */
  allows(url: string): boolean;
}

export function createHistorySuppression(): HistorySuppression {
  const removed = new Set<string>(); // keys removed one by one, not visited since
  let allRemoved = false; // the whole history was cleared...
  const visitedSince = new Set<string>(); // ...and these were visited after

  return {
    removed(urls) {
      if (urls === 'all') {
        allRemoved = true;
        removed.clear();
        visitedSince.clear();
        return;
      }
      for (const url of urls) {
        const key = previewKey(url);
        removed.add(key);
        visitedSince.delete(key);
      }
    },
    visited(url) {
      const key = previewKey(url);
      removed.delete(key);
      if (allRemoved) visitedSince.add(key);
    },
    allows(url) {
      const key = previewKey(url);
      if (removed.has(key)) return false;
      return !allRemoved || visitedSince.has(key);
    },
  };
}

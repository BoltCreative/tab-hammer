import type { WindowNode } from '../../model/types';

/**
 * A fingerprint of what the hover card for tab `key` sits on: the order of every visible row in
 * the view (so a change in any window above, or a collapse, which moves the row, closes the card)
 * and the tab's URL (the card's preview and URL would be stale). The title is deliberately left
 * out: the card renders it live, so pages with ticking titles (unread counts) don't keep closing
 * it. Undefined if the tab is gone or hidden.
 */
export function hoverSignature(
  tree: readonly WindowNode[],
  visibleRows: readonly string[],
  key: string,
): string | undefined {
  if (!visibleRows.includes(key)) return undefined;
  for (const w of tree) {
    for (const c of w.children) {
      const tab = (c.kind === 'group' ? c.tabs : [c]).find((t) => t.key === key);
      if (tab) return JSON.stringify([visibleRows, tab.url]);
    }
  }
  return undefined;
}

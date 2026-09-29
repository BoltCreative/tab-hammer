import type { WindowNode } from '../../model/types';
import { allRowKeys } from '../../model/visibleRows';

/**
 * A fingerprint of what the hover card for tab `key` sits on: the rows of the tab's window and
 * the tab's title and URL. The card closes when it changes, since the row may have moved or the
 * card's content gone stale. Undefined if the tab is gone.
 */
export function hoverSignature(tree: readonly WindowNode[], key: string): string | undefined {
  for (const w of tree) {
    for (const c of w.children) {
      const tab = (c.kind === 'group' ? c.tabs : [c]).find((t) => t.key === key);
      if (tab) return JSON.stringify([[...allRowKeys([w])], tab.title, tab.url]);
    }
  }
  return undefined;
}

import type { WindowNode } from './types';
import { isGroupCollapsed, type CollapseState } from './visibleRows';

/** One visible outline row, with what the ARIA tree pattern and keyboard navigation need. */
export interface OutlineRow {
  key: string;
  kind: 'window' | 'group' | 'tab';
  level: 1 | 2 | 3;
  parent: string | null;
  /** Expanded or not, for rows that can collapse; undefined for tabs (and while all is expanded). */
  expanded?: boolean;
  setSize: number;
  posInSet: number; // 1-based
}

/** The outline's visible rows in display order. */
export function outlineRows(tree: WindowNode[], c: CollapseState): OutlineRow[] {
  const out: OutlineRow[] = [];
  const collapsible = !c.expandAll;
  tree.forEach((w, wi) => {
    const open = !c.collapsedWindows.has(w.key);
    out.push({
      key: w.key,
      kind: 'window',
      level: 1,
      parent: null,
      expanded: collapsible ? open : undefined,
      setSize: tree.length,
      posInSet: wi + 1,
    });
    if (!open) return;
    w.children.forEach((child, ci) => {
      const base = {
        level: 2 as const,
        parent: w.key,
        setSize: w.children.length,
        posInSet: ci + 1,
      };
      if (child.kind === 'tab') {
        out.push({ key: child.key, kind: 'tab', ...base });
        return;
      }
      const groupOpen = !isGroupCollapsed(child, c);
      out.push({
        key: child.key,
        kind: 'group',
        ...base,
        expanded: collapsible ? groupOpen : undefined,
      });
      if (!groupOpen) return;
      child.tabs.forEach((t, ti) =>
        out.push({
          key: t.key,
          kind: 'tab',
          level: 3,
          parent: child.key,
          setSize: child.tabs.length,
          posInSet: ti + 1,
        }),
      );
    });
  });
  return out;
}

export type NavIntent =
  | { type: 'move'; key: string; extend: boolean } // put the cursor on key (and select it)
  | { type: 'toggleSelect'; key: string } // add/remove the cursor row from the selection
  | { type: 'toggleExpand'; key: string }
  | { type: 'activate'; key: string };

/**
 * What a key press in the outline means, following the ARIA tree pattern: Up/Down (Shift extends
 * the selection), Home/End, Right expands or steps into a row's children, Left collapses or steps
 * out to the parent, Enter activates, Space toggles the row in the selection. Null for any other
 * key, or when there's nothing to do.
 */
export function navIntent(
  rows: readonly OutlineRow[],
  cursor: string | null,
  key: string,
  shift: boolean,
): NavIntent | null {
  if (rows.length === 0) return null;
  const i = cursor === null ? -1 : rows.findIndex((r) => r.key === cursor);
  const move = (j: number): NavIntent => ({
    type: 'move',
    key: rows[Math.max(0, Math.min(rows.length - 1, j))]!.key,
    extend: shift,
  });
  // No cursor yet (or it scrolled out of the outline): any navigation key lands on the first row.
  if (i === -1) {
    return ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(key)
      ? move(key === 'End' ? rows.length - 1 : 0)
      : null;
  }
  const row = rows[i]!;
  switch (key) {
    case 'ArrowDown':
      return i < rows.length - 1 ? move(i + 1) : null;
    case 'ArrowUp':
      return i > 0 ? move(i - 1) : null;
    case 'Home':
      return move(0);
    case 'End':
      return move(rows.length - 1);
    case 'ArrowRight':
      if (row.expanded === false) return { type: 'toggleExpand', key: row.key };
      if (row.kind !== 'tab' && rows[i + 1]?.parent === row.key) return move(i + 1);
      return null;
    case 'ArrowLeft': {
      if (row.expanded === true) return { type: 'toggleExpand', key: row.key };
      if (row.parent === null) return null;
      return { type: 'move', key: row.parent, extend: false };
    }
    case 'Enter':
      return { type: 'activate', key: row.key };
    case ' ':
      return { type: 'toggleSelect', key: row.key };
    default:
      return null;
  }
}

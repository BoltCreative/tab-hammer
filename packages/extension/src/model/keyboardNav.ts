import type { WindowNode } from './types';
import { shortcutOf, type KeyPress, type ShortcutId } from './shortcuts';
import { isGroupCollapsed, type CollapseState } from './visibleRows';

/** One visible outline row, with what the ARIA tree pattern and keyboard navigation need. */
export interface OutlineRow {
  key: string;
  /** 'section' is the Recently closed section's own header. */
  kind: 'window' | 'group' | 'tab' | 'section';
  /** Rows of the Recently closed section: the cursor reaches them, but they're never selected. */
  trash?: true;
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

/** The Recently closed section's header row, as a cursor key. */
export const TRASH_SECTION_KEY = 'trash-section';

/**
 * Recently closed's rows, after the outline's, so the one cursor runs on into it: the section
 * header, then (open) each closed window, then (expanded) that window's tabs.
 */
export function trashRows(
  entries: readonly WindowNode[],
  open: boolean,
  expandedEntries: ReadonlySet<string>,
): OutlineRow[] {
  if (entries.length === 0) return [];
  const out: OutlineRow[] = [
    {
      key: TRASH_SECTION_KEY,
      kind: 'section',
      trash: true,
      level: 1,
      parent: null,
      expanded: open,
      setSize: 1,
      posInSet: 1,
    },
  ];
  if (!open) return out;
  entries.forEach((w, wi) => {
    const expanded = expandedEntries.has(w.key);
    out.push({
      key: w.key,
      kind: 'window',
      trash: true,
      level: 2,
      parent: TRASH_SECTION_KEY,
      expanded,
      setSize: entries.length,
      posInSet: wi + 1,
    });
    if (!expanded) return;
    const tabs = w.children.flatMap((c) => (c.kind === 'group' ? c.tabs : [c]));
    tabs.forEach((t, ti) =>
      out.push({
        key: t.key,
        kind: 'tab',
        trash: true,
        level: 3,
        parent: w.key,
        setSize: tabs.length,
        posInSet: ti + 1,
      }),
    );
  });
  return out;
}

export { keyPressOf, type KeyPress } from './shortcuts';

export type NavIntent =
  | { type: 'move'; key: string; extend: boolean } // put the cursor on key (and select it)
  | { type: 'toggleExpand'; key: string }
  | { type: 'activate'; key: string }
  | { type: 'trash'; key: string } // trash the selection, or the cursor row if none
  | { type: 'moveWindow'; key: string; delta: -1 | 1 }; // move the cursor's window one place

/**
 * What a key press means to the outline, command-palette style: focus stays in the search box,
 * so every text-editing key is left to it and only these drive the list (each one a row of
 * `SHORTCUTS`). ↑/↓ move the cursor (⇧ extends the selection), ⌥↑/↓ move the cursor's window, ⌘↓
 * opens (expands a collapsed row, steps into an open one's children, activates a tab), ⌘↑
 * collapses or steps out to the parent, ⌘⌫ trashes, and Enter opens the cursor row. Null for any
 * other key, or when there's nothing to do.
 */
export function navIntent(
  rows: readonly OutlineRow[],
  cursor: string | null,
  p: KeyPress,
): NavIntent | null {
  if (rows.length === 0) return null;
  const id = shortcutOf(p);
  const i = cursor === null ? -1 : rows.findIndex((r) => r.key === cursor);
  const row = i === -1 ? undefined : rows[i]!;
  const move = (j: number, extend: boolean): NavIntent => {
    const to = rows[Math.max(0, Math.min(rows.length - 1, j))]!;
    // The selection never takes in Recently closed's rows.
    return { type: 'move', key: to.key, extend: extend && !to.trash && !row?.trash };
  };
  const down = p.key === 'ArrowDown';

  switch (id) {
    case 'moveWindow':
      return row && !row.trash ? { type: 'moveWindow', key: row.key, delta: down ? 1 : -1 } : null;
    case 'open':
      if (!row) return null;
      if (row.expanded === false) return { type: 'toggleExpand', key: row.key };
      if (row.kind === 'tab') return { type: 'activate', key: row.key };
      if (rows[i + 1]?.parent === row.key) return move(i + 1, false);
      return null;
    case 'up':
      if (!row) return null;
      if (row.expanded === true) return { type: 'toggleExpand', key: row.key };
      if (row.parent === null) return null;
      return { type: 'move', key: row.parent, extend: false };
    case 'move':
    case 'select': {
      const extend = id === 'select';
      // No cursor yet (or its row went away): ↓ lands on the first row, ↑ on the last.
      if (!row) return move(down ? 0 : rows.length - 1, extend);
      if (down) return i < rows.length - 1 ? move(i + 1, extend) : null;
      return i > 0 ? move(i - 1, extend) : null;
    }
    case 'trash':
      return row && !row.trash ? { type: 'trash', key: row.key } : null;
    case 'activate':
      return row ? { type: 'activate', key: row.key } : null;
    default:
      return null;
  }
}

/**
 * Whether a key pressed outside any text field is typing, which the search box should receive:
 * a printable character (Space and ⌥ characters included), a dead key or IME composition
 * starting, or Backspace. ⌘/Ctrl combos are the browser's (AltGr, which reports Ctrl+Alt, types).
 */
export function typesIntoSearch(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altGraph: boolean;
  isComposing: boolean;
}): boolean {
  if (e.metaKey || (e.ctrlKey && !e.altGraph)) return false;
  if (e.isComposing) return true;
  return (
    [...e.key].length === 1 || e.key === 'Dead' || e.key === 'Process' || e.key === 'Backspace'
  );
}

/** The view's own ⌘ shortcuts (Ctrl off a Mac), none of them Chrome's or macOS's. */
export type ViewShortcut = Extract<ShortcutId, 'currentTabs' | 'recenter' | 'shortcuts'>;

/** ⌘/ toggles Current tabs, ⌘\ recenters on the current window's tab, ⌘' shows the shortcuts. */
export function viewShortcut(p: KeyPress): ViewShortcut | null {
  const id = shortcutOf(p);
  return id === 'currentTabs' || id === 'recenter' || id === 'shortcuts' ? id : null;
}

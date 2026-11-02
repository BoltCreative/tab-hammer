// Turns "drop these selected rows here" into the Chrome calls that make it so. Pure: it reads the
// view model and returns a list of operations; chromeSource.applyMoveOps runs them in order.
import type { GroupNode, TabNode, WindowNode } from './types';

/** Where, relative to the row under the pointer, the dragged rows land. */
export type DropPosition = 'before' | 'after' | 'inside';

export interface DropTarget {
  key: string;
  position: DropPosition;
}

export type MoveOp =
  | { op: 'moveTab'; tabId: number; windowId: number; index: number }
  | { op: 'moveGroup'; groupId: number; windowId: number; index: number }
  | { op: 'group'; tabIds: number[]; groupId: number }
  | { op: 'ungroup'; tabIds: number[] }
  // Moves a tab (already in the anchor's window) to just before/after the anchor tab, wherever
  // the two are at that moment.
  | { op: 'moveNextTo'; tabId: number; anchorTabId: number; side: 'before' | 'after' };

/**
 * Which drop a pointer at `fraction` (0 = top edge, 1 = bottom edge) of a row means. Tab rows
 * split in half (before/after). A group header's top half drops before the group, outside it; its
 * bottom half drops into the group. A window header always means "the end of this window".
 */
export function dropPositionFor(kind: 'window' | 'group' | 'tab', fraction: number): DropPosition {
  if (kind === 'window') return 'inside';
  if (kind === 'group') return fraction < 0.5 ? 'before' : 'inside';
  return fraction < 0.5 ? 'before' : 'after';
}

/**
 * The rows a drag carries: the whole selection when the drag starts on a selected row, otherwise
 * just the row it starts on. Window headers never move.
 */
export function dragKeys(selected: ReadonlySet<string>, startKey: string): string[] {
  const keys = selected.has(startKey) ? [...selected] : [startKey];
  return keys.filter((k) => !k.startsWith('w:'));
}

// One thing that moves as a block: a loose tab, or a whole group run.
type Unit = { kind: 'tab'; tab: TabNode; groupId: number } | { kind: 'group'; group: GroupNode };

interface Located {
  win: WindowNode;
  group: GroupNode | null; // the group run the node is in (for a tab), or the node itself
  node: WindowNode | GroupNode | TabNode;
}

function locate(tree: WindowNode[]): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const win of tree) {
    out.set(win.key, { win, group: null, node: win });
    for (const c of win.children) {
      if (c.kind === 'group') {
        out.set(c.key, { win, group: c, node: c });
        for (const t of c.tabs) out.set(t.key, { win, group: c, node: t });
      } else {
        out.set(c.key, { win, group: null, node: c });
      }
    }
  }
  return out;
}

function tabsOf(win: WindowNode): TabNode[] {
  return win.children.flatMap((c) => (c.kind === 'group' ? c.tabs : [c]));
}

// The units being moved, in outline order. A tab inside a moved group travels with its group.
function unitsFor(tree: WindowNode[], keys: ReadonlySet<string>): Unit[] {
  const units: Unit[] = [];
  for (const win of tree) {
    for (const c of win.children) {
      if (c.kind === 'group') {
        if (keys.has(c.key)) {
          units.push({ kind: 'group', group: c });
          continue;
        }
        for (const t of c.tabs) {
          if (keys.has(t.key)) units.push({ kind: 'tab', tab: t, groupId: c.groupId });
        }
      } else if (keys.has(c.key)) {
        units.push({ kind: 'tab', tab: c, groupId: -1 });
      }
    }
  }
  return units;
}

function unitTabIds(u: Unit): number[] {
  return u.kind === 'tab' ? [u.tab.tabId] : u.group.tabs.map((t) => t.tabId);
}

// Whether this group run is all of its group (Chrome can then move the group as one piece).
function isWholeGroup(tree: WindowNode[], g: GroupNode): boolean {
  let runs = 0;
  for (const w of tree)
    for (const c of w.children) if (c.kind === 'group' && c.groupId === g.groupId) runs++;
  return runs === 1;
}

/**
 * Plans moving the rows `keys` to `target`. Returns [] when the drop changes nothing that can be
 * done (nothing movable, or dropping the rows onto themselves).
 *
 * Rules: dropping beside a tab that is in a group, or into a group, puts every moved tab in that
 * group (a moved group's tabs join it too: groups don't nest). Dropping anywhere else leaves moved
 * groups intact and takes moved tabs out of their groups.
 */
export function planMove(
  tree: WindowNode[],
  keys: readonly string[],
  target: DropTarget,
): MoveOp[] {
  const where = locate(tree);
  const keySet = new Set(keys);
  const units = unitsFor(tree, keySet);
  const at = where.get(target.key);
  if (units.length === 0 || !at) return [];

  // Dropping onto a moved row, or into/beside a moved group, has no fixed point to land at.
  const moved = new Set(units.flatMap(unitTabIds));
  if (keySet.has(target.key)) return [];
  if (at.group && keySet.has(at.group.key)) return [];
  if (at.node.kind === 'tab' && moved.has(at.node.tabId)) return [];

  const win = at.win;
  const remaining = tabsOf(win).filter((t) => !moved.has(t.tabId));

  // Where, in the target window's tabs that stay put, the moved tabs go; and which group they join.
  let insertAt: number; // index into `remaining`
  let joinGroup: GroupNode | null = null;
  const node = at.node;
  if (node.kind === 'window') {
    insertAt = remaining.length;
  } else if (node.kind === 'group') {
    const staying = node.tabs.filter((t) => !moved.has(t.tabId));
    if (staying.length === 0) return []; // the group would vanish under the drop
    // Before the group (outside it), or into it at its start.
    insertAt = remaining.indexOf(staying[0]!);
    if (target.position !== 'before') joinGroup = node;
  } else {
    const i = remaining.indexOf(node);
    insertAt = target.position === 'after' ? i + 1 : i;
    joinGroup = at.group;
  }

  if (joinGroup) return planJoin(units, remaining, insertAt, joinGroup);

  // Simulate Chrome's tab strips so each call's index is right at the moment it runs: every move
  // removes the tabs from where they are, then inserts them at the index.
  const strips = new Map<number, number[]>(
    tree.map((w) => [w.windowId, tabsOf(w).map((t) => t.tabId)]),
  );
  const removeFrom = (ids: number[]) => {
    for (const strip of strips.values()) {
      for (const id of ids) {
        const i = strip.indexOf(id);
        if (i !== -1) strip.splice(i, 1);
      }
    }
  };
  const dest = strips.get(win.windowId)!;
  const anchor = insertAt < remaining.length ? remaining[insertAt]!.tabId : null;

  const ops: MoveOp[] = [];
  let prev: number | null = null; // the last tab placed so far
  for (const u of units) {
    const ids = unitTabIds(u);
    removeFrom(ids);
    const index: number =
      prev !== null ? dest.indexOf(prev) + 1 : anchor !== null ? dest.indexOf(anchor) : dest.length;
    dest.splice(index, 0, ...ids);
    prev = ids[ids.length - 1]!;
    if (u.kind === 'group' && isWholeGroup(tree, u.group)) {
      ops.push({ op: 'moveGroup', groupId: u.group.groupId, windowId: win.windowId, index });
    } else {
      ids.forEach((tabId, i) =>
        ops.push({ op: 'moveTab', tabId, windowId: win.windowId, index: index + i }),
      );
    }
  }

  // Settle group membership explicitly: Chrome's own choice after a move depends on where the tab
  // landed relative to group edges, and moving across windows drops a tab's group.
  const loose = units.flatMap((u) => (u.kind === 'tab' ? [u.tab.tabId] : []));
  if (loose.length > 0) ops.push({ op: 'ungroup', tabIds: loose });
  // A split group run, moved tab by tab, is put back into its own group.
  for (const u of units) {
    if (u.kind === 'group' && !isWholeGroup(tree, u.group)) {
      ops.push({ op: 'group', tabIds: unitTabIds(u), groupId: u.group.groupId });
    }
  }
  return ops;
}

// Joining a group: Chrome refuses to move a tab into the middle of a group it is not in, so the
// tabs join the group first (Chrome pulls them over, next to it), then are ordered within it.
function planJoin(
  units: Unit[],
  remaining: TabNode[],
  insertAt: number,
  group: GroupNode,
): MoveOp[] {
  const ids = units.flatMap(unitTabIds);
  const inGroup = new Set(group.tabs.map((t) => t.tabId));
  const next = remaining[insertAt];
  const first: MoveOp & { op: 'moveNextTo' } =
    next && inGroup.has(next.tabId)
      ? { op: 'moveNextTo', tabId: ids[0]!, anchorTabId: next.tabId, side: 'before' }
      : {
          op: 'moveNextTo',
          tabId: ids[0]!,
          anchorTabId: remaining[insertAt - 1]!.tabId,
          side: 'after',
        };
  const ops: MoveOp[] = [{ op: 'group', tabIds: ids, groupId: group.groupId }, first];
  for (let i = 1; i < ids.length; i++) {
    ops.push({ op: 'moveNextTo', tabId: ids[i]!, anchorTabId: ids[i - 1]!, side: 'after' });
  }
  return ops;
}

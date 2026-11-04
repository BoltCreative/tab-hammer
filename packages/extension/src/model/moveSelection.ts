// Turns "drop these selected rows here" into what makes it so: the Chrome calls that move the live
// tabs (chromeSource.applyMoveOps runs them in order) and, when hibernated rows are involved, where
// the worker places the moved tab records in the outline. Pure: it reads the view model only.
import type { Placement } from './outline/place';
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
 * just the row it starts on. A window header carries all of its window's rows.
 */
export function dragKeys(selected: ReadonlySet<string>, startKey: string): string[] {
  return selected.has(startKey) ? [...selected] : [startKey];
}

// One thing that moves as a block: a loose tab, or a whole group run.
type Unit = { kind: 'tab'; tab: TabNode } | { kind: 'group'; group: GroupNode };

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

// Hibernated rows have no Chrome tabs to move: planMove plans live rows only.
function isLive(n: WindowNode | GroupNode | TabNode): boolean {
  return !n.hibernated;
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
          if (keys.has(t.key)) units.push({ kind: 'tab', tab: t });
        }
      } else if (keys.has(c.key)) {
        units.push({ kind: 'tab', tab: c });
      }
    }
  }
  return units;
}

function unitTabs(u: Unit): TabNode[] {
  return u.kind === 'tab' ? [u.tab] : u.group.tabs;
}

function unitTabIds(u: Unit): number[] {
  return unitTabs(u).map((t) => t.tabId!);
}

// Whether this group run is all of its group (Chrome can then move the group as one piece).
function isWholeGroup(tree: WindowNode[], g: GroupNode): boolean {
  let runs = 0;
  for (const w of tree) for (const c of w.children) if (c.kind === 'group' && c.id === g.id) runs++;
  return runs === 1;
}

// Where a drop lands: the target window, its tabs that stay put, the index into those the moved
// tabs go at, and the group they join.
interface Landing {
  win: WindowNode;
  remaining: TabNode[];
  insertAt: number;
  joinGroup: GroupNode | null;
}

/** Null when the drop has no fixed point to land at (onto a moved row, or into a moved group). */
function landing(
  keys: ReadonlySet<string>,
  units: Unit[],
  at: Located,
  target: DropTarget,
): Landing | null {
  const moved = new Set(units.flatMap(unitTabs).map((t) => t.key));
  if (keys.has(target.key) || keys.has(at.win.key)) return null;
  if (at.group && keys.has(at.group.key)) return null;
  if (at.node.kind === 'tab' && moved.has(at.node.key)) return null;

  const win = at.win;
  const remaining = tabsOf(win).filter((t) => !moved.has(t.key));
  const node = at.node;
  if (node.kind === 'window')
    return { win, remaining, insertAt: remaining.length, joinGroup: null };
  if (node.kind === 'group') {
    const staying = node.tabs.filter((t) => !moved.has(t.key));
    if (staying.length === 0) return null; // the group would vanish under the drop
    // Before the group (outside it), or into it at its start.
    const insertAt = remaining.indexOf(staying[0]!);
    return { win, remaining, insertAt, joinGroup: target.position === 'before' ? null : node };
  }
  const i = remaining.indexOf(node);
  const insertAt = target.position === 'after' ? i + 1 : i;
  return { win, remaining, insertAt, joinGroup: at.group };
}

/**
 * Plans moving the live rows `keys` to the live row `target` in Chrome. Returns [] when the drop
 * changes nothing that can be done (nothing movable, a hibernated row involved, or dropping the
 * rows onto themselves).
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
  if (!isLive(at.win) || !isLive(at.node)) return [];
  if (units.some((u) => unitTabs(u).some((t) => !isLive(t)))) return [];

  const land = landing(keySet, units, at, target);
  if (!land) return [];
  const { win, remaining, insertAt, joinGroup } = land;

  if (joinGroup) return planJoin(units, remaining, insertAt, joinGroup);

  // Simulate Chrome's tab strips so each call's index is right at the moment it runs: every move
  // removes the tabs from where they are, then inserts them at the index.
  const strips = new Map<number, number[]>(
    tree.filter(isLive).map((w) => [w.windowId!, tabsOf(w).flatMap((t) => t.tabId ?? [])]),
  );
  const removeFrom = (ids: number[]) => {
    for (const strip of strips.values()) {
      for (const id of ids) {
        const i = strip.indexOf(id);
        if (i !== -1) strip.splice(i, 1);
      }
    }
  };
  const windowId = win.windowId!;
  const dest = strips.get(windowId)!;
  const anchor = insertAt < remaining.length ? remaining[insertAt]!.tabId! : null;

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
      ops.push({ op: 'moveGroup', groupId: u.group.chromeGroupId!, windowId, index });
    } else {
      ids.forEach((tabId, i) => ops.push({ op: 'moveTab', tabId, windowId, index: index + i }));
    }
  }

  // Settle group membership explicitly: Chrome's own choice after a move depends on where the tab
  // landed relative to group edges, and moving across windows drops a tab's group.
  const loose = units.flatMap((u) => (u.kind === 'tab' ? [u.tab.tabId!] : []));
  if (loose.length > 0) ops.push({ op: 'ungroup', tabIds: loose });
  // A split group run, moved tab by tab, is put back into its own group.
  for (const u of units) {
    if (u.kind === 'group' && !isWholeGroup(tree, u.group)) {
      ops.push({ op: 'group', tabIds: unitTabIds(u), groupId: u.group.chromeGroupId! });
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
  const inGroup = new Set(group.tabs.map((t) => t.tabId!));
  const next = remaining[insertAt];
  const first: MoveOp & { op: 'moveNextTo' } =
    next && inGroup.has(next.tabId!)
      ? { op: 'moveNextTo', tabId: ids[0]!, anchorTabId: next.tabId!, side: 'before' }
      : {
          op: 'moveNextTo',
          tabId: ids[0]!,
          anchorTabId: remaining[insertAt - 1]!.tabId!,
          side: 'after',
        };
  const ops: MoveOp[] = [{ op: 'group', tabIds: ids, groupId: group.chromeGroupId! }, first];
  for (let i = 1; i < ids.length; i++) {
    ops.push({ op: 'moveNextTo', tabId: ids[i]!, anchorTabId: ids[i - 1]!, side: 'after' });
  }
  return ops;
}

/** What a drop does: Chrome moves for the live tabs, then (if needed) an outline placement. */
export interface DropPlan {
  chrome: MoveOp[];
  place: Placement | null;
}

const NOTHING: DropPlan = { chrome: [], place: null };

/**
 * Plans dropping the rows `keys` (live or hibernated; a window row stands for all its rows) on
 * `target`. Live tabs move in Chrome; the worker's outline follows Chrome's order. A placement is
 * sent as well whenever Chrome's order can't say where the rows go in the outline: a hibernated tab
 * moves, the target window is hibernated (its live tabs are closed there), the joined group has no
 * Chrome group yet, or the drop lands just before a hibernated row.
 *
 * Run the Chrome moves first, then the placement: the worker reconciles with Chrome before placing.
 */
export function planDrop(
  tree: WindowNode[],
  keys: readonly string[],
  target: DropTarget,
): DropPlan {
  const keySet = withWindowRows(tree, keys);
  const units = unitsFor(tree, keySet);
  const at = locate(tree).get(target.key);
  if (units.length === 0 || !at) return NOTHING;
  const land = landing(keySet, units, at, target);
  if (!land) return NOTHING;
  const { win, remaining, insertAt, joinGroup } = land;

  const next = remaining[insertAt];
  const placed = units.flatMap((u) =>
    unitTabs(u).map((t) => ({
      tab: t,
      groupId: joinGroup?.id ?? (u.kind === 'group' ? u.group.id : null),
    })),
  );
  const needsPlace =
    win.hibernated ||
    placed.some((p) => p.tab.hibernated) ||
    (joinGroup !== null && joinGroup.chromeGroupId === undefined) ||
    next?.hibernated === true;
  const place: Placement | null = needsPlace
    ? {
        windowId: win.id,
        beforeTabId: next?.id ?? null,
        tabs: placed.map((p) => ({ id: p.tab.id, groupId: p.groupId })),
      }
    : null;
  if (win.hibernated) return { chrome: [], place };

  const live = liveProjection(tree);
  const liveKeys = units.flatMap((u) =>
    u.kind === 'tab'
      ? u.tab.hibernated
        ? []
        : [u.tab.key]
      : u.group.hibernated
        ? []
        : [u.group.key],
  );
  const chrome =
    liveKeys.length === 0 ? [] : planMove(live, liveKeys, liveTarget(live, land, target));
  return { chrome, place };
}

// The selected keys plus every row of each selected window.
function withWindowRows(tree: WindowNode[], keys: readonly string[]): Set<string> {
  const out = new Set(keys);
  for (const w of tree) if (out.has(w.key)) for (const c of w.children) out.add(c.key);
  return out;
}

// The tree as Chrome has it: hibernated tabs gone, and groups left with no tabs dropped.
function liveProjection(tree: WindowNode[]): WindowNode[] {
  return tree.filter(isLive).map((w) => ({
    ...w,
    children: w.children.flatMap((c): (GroupNode | TabNode)[] => {
      if (c.kind === 'tab') return c.hibernated ? [] : [c];
      return c.hibernated ? [] : [{ ...c, tabs: c.tabs.filter(isLive) }];
    }),
  }));
}

// The drop target as a row of the live projection. A live row stands for itself (a group header
// only while some of its live tabs stay put). Otherwise the drop point is anchored on live rows:
// inside the joined Chrome group next to one of its live tabs, else before the next live tab (or
// its group run, so as not to join it), else at the window's end.
function liveTarget(live: WindowNode[], land: Landing, target: DropTarget): DropTarget {
  const { win, remaining, insertAt, joinGroup } = land;
  const where = locate(live);
  const projected = where.get(target.key)?.node;
  if (
    projected &&
    (projected.kind !== 'group' || projected.tabs.some((t) => remaining.includes(t)))
  )
    return target;
  const after = remaining.slice(insertAt).filter(isLive);
  const before = remaining.slice(0, insertAt).filter(isLive);
  const groupOf = (t: TabNode) => where.get(t.key)!.group;
  if (joinGroup?.chromeGroupId !== undefined) {
    const inGroup = (t: TabNode) => groupOf(t)?.chromeGroupId === joinGroup.chromeGroupId;
    if (after[0] && inGroup(after[0])) return { key: after[0].key, position: 'before' };
    const prev = before[before.length - 1];
    if (prev && inGroup(prev)) return { key: prev.key, position: 'after' };
  }
  const nextLive = after[0];
  if (!nextLive) return { key: win.key, position: 'inside' };
  const run = groupOf(nextLive);
  return { key: run ? run.key : nextLive.key, position: 'before' };
}

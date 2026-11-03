import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { dragKeys, dropPositionFor, planMove, type MoveOp } from '../moveSelection';
import type { WindowNode } from '../types';
import { group, state, tab, win } from './outlineState';

// Window 1: [g:10 (1, 2)] 3 4 ; Window 2: 5 [g:20 (6, 7)]. Record IDs match the Chrome IDs.
function layout(): WindowNode[] {
  const t = (id: number, groupId?: string) =>
    tab(`${id}`, { chromeTabId: id, title: `T${id}`, groupId });
  return buildTree(
    state({
      windows: [
        win('1', {
          chromeWindowId: 1,
          groups: [group('10', { chromeGroupId: 10 })],
          tabs: [t(1, '10'), t(2, '10'), t(3), t(4)],
        }),
        win('2', {
          chromeWindowId: 2,
          groups: [group('20', { chromeGroupId: 20 })],
          tabs: [t(5), t(6, '20'), t(7, '20')],
        }),
      ],
    }),
  ).windows;
}

// Replays ops on a model of Chrome's strips the way Chrome applies them (remove, then insert at
// index), so tests assert where tabs end up rather than the exact calls.
function apply(tree: WindowNode[], ops: MoveOp[]) {
  const strips = new Map<number, { id: number; group: number }[]>();
  for (const w of tree) {
    strips.set(
      w.windowId!,
      w.children.flatMap((c) =>
        c.kind === 'group'
          ? c.tabs.map((t) => ({ id: t.tabId!, group: c.chromeGroupId! }))
          : [{ id: c.tabId!, group: -1 }],
      ),
    );
  }
  const take = (pred: (t: { id: number; group: number }) => boolean) => {
    const out: { id: number; group: number }[] = [];
    for (const s of strips.values()) {
      for (let i = s.length - 1; i >= 0; i--) if (pred(s[i]!)) out.unshift(...s.splice(i, 1));
    }
    return out;
  };
  for (const o of ops) {
    if (o.op === 'moveTab') {
      const [t] = take((x) => x.id === o.tabId);
      strips.get(o.windowId)!.splice(o.index, 0, t!);
    } else if (o.op === 'moveGroup') {
      const ts = take((x) => x.group === o.groupId);
      strips.get(o.windowId)!.splice(o.index, 0, ...ts);
    } else if (o.op === 'moveNextTo') {
      const [t] = take((x) => x.id === o.tabId);
      for (const s of strips.values()) {
        const i = s.findIndex((x) => x.id === o.anchorTabId);
        if (i !== -1) s.splice(o.side === 'before' ? i : i + 1, 0, t!);
      }
    } else if (o.op === 'group') {
      // Chrome pulls tabs that join a group over to just after it.
      const joining = take((x) => o.tabIds.includes(x.id) && x.group !== o.groupId);
      for (const s of strips.values()) {
        const last = s.map((x) => x.group).lastIndexOf(o.groupId);
        if (last !== -1) s.splice(last + 1, 0, ...joining.map((x) => ({ ...x, group: o.groupId })));
      }
    } else {
      for (const s of strips.values()) for (const t of s) if (o.tabIds.includes(t.id)) t.group = -1;
    }
  }
  return Object.fromEntries(
    [...strips].map(([w, s]) => [
      w,
      s.map((t) => (t.group === -1 ? `${t.id}` : `${t.id}g${t.group}`)),
    ]),
  );
}

describe('dropPositionFor', () => {
  it('splits tab rows in half, group headers into before/inside, windows always inside', () => {
    expect(dropPositionFor('tab', 0.2)).toBe('before');
    expect(dropPositionFor('tab', 0.8)).toBe('after');
    expect(dropPositionFor('group', 0.2)).toBe('before');
    expect(dropPositionFor('group', 0.8)).toBe('inside');
    expect(dropPositionFor('window', 0.1)).toBe('inside');
  });
});

describe('dragKeys', () => {
  it('drags the selection from a selected row, else only the row, never windows', () => {
    const sel = new Set(['t:1', 'w:1', 'g:20']);
    expect(dragKeys(sel, 't:1').sort()).toEqual(['g:20', 't:1']);
    expect(dragKeys(sel, 't:4')).toEqual(['t:4']);
  });
});

describe('planMove', () => {
  it('moves a tab later in its own window', () => {
    const tree = layout();
    expect(apply(tree, planMove(tree, ['t:3'], { key: 't:4', position: 'after' }))[1]).toEqual([
      '1g10',
      '2g10',
      '4',
      '3',
    ]);
  });

  it('moves several tabs, in outline order, earlier in a window and out of their group', () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['t:4', 't:2'], { key: 'g:10', position: 'before' }));
    expect(r[1]).toEqual(['2', '4', '1g10', '3']);
  });

  it('moves tabs across windows into a group, joining it', () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['t:3', 't:1'], { key: 't:6', position: 'after' }));
    expect(r).toEqual({ 1: ['2g10', '4'], 2: ['5', '6g20', '1g20', '3g20', '7g20'] });
  });

  it('joins a group by grouping first, then placing (Chrome rejects moves into a group)', () => {
    const tree = layout();
    const ops = planMove(tree, ['t:5'], { key: 't:7', position: 'before' });
    expect(ops[0]).toEqual({ op: 'group', tabIds: [5], groupId: 20 });
    expect(ops.some((o) => o.op === 'moveTab')).toBe(false);
  });

  it('joins a group at its end when dropped after its last tab', () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['t:3', 't:4'], { key: 't:2', position: 'after' }));
    expect(r[1]).toEqual(['1g10', '2g10', '3g10', '4g10']);
    const r2 = apply(tree, planMove(tree, ['t:3', 't:1'], { key: 't:7', position: 'after' }));
    expect(r2[2]).toEqual(['5', '6g20', '7g20', '1g20', '3g20']);
  });

  it('drops into a group header at the group start', () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['t:5'], { key: 'g:20', position: 'inside' }));
    expect(r[2]).toEqual(['5g20', '6g20', '7g20']);
  });

  it('moves a whole group to the end of another window as one group', () => {
    const tree = layout();
    const ops = planMove(tree, ['g:10'], { key: 'w:2', position: 'inside' });
    expect(ops).toEqual([{ op: 'moveGroup', groupId: 10, windowId: 2, index: 3 }]);
    expect(apply(tree, ops)).toEqual({
      1: ['3', '4'],
      2: ['5', '6g20', '7g20', '1g10', '2g10'],
    });
  });

  it('moves a group later in its own window', () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['g:10'], { key: 't:4', position: 'after' }));
    expect(r[1]).toEqual(['3', '4', '1g10', '2g10']);
  });

  it("merges a dragged group's tabs into the group it is dropped in", () => {
    const tree = layout();
    const r = apply(tree, planMove(tree, ['g:10'], { key: 't:7', position: 'before' }));
    expect(r[2]).toEqual(['5', '6g20', '1g20', '2g20', '7g20']);
  });

  it('carries a tab with its selected group instead of moving it twice', () => {
    const tree = layout();
    const ops = planMove(tree, ['g:10', 't:1', 't:3'], { key: 'w:2', position: 'inside' });
    expect(apply(tree, ops)[2]).toEqual(['5', '6g20', '7g20', '1g10', '2g10', '3']);
  });

  it('does nothing when dropped onto a moved row or inside a moved group', () => {
    const tree = layout();
    expect(planMove(tree, ['t:3'], { key: 't:3', position: 'after' })).toEqual([]);
    expect(planMove(tree, ['g:10'], { key: 't:1', position: 'after' })).toEqual([]);
    expect(planMove(tree, ['w:1'], { key: 't:5', position: 'after' })).toEqual([]);
  });

  it('does nothing when dropping into a group whose every tab is being moved', () => {
    const tree = layout();
    expect(planMove(tree, ['t:6', 't:7'], { key: 'g:20', position: 'inside' })).toEqual([]);
  });

  it('does nothing with hibernated rows, which have no Chrome tabs to move', () => {
    const tree = buildTree(
      state({
        windows: [
          win('1', { chromeWindowId: 1, tabs: [tab('1', { chromeTabId: 1 })] }),
          win('h', { tabs: [tab('x')] }),
        ],
      }),
    ).windows;
    expect(planMove(tree, ['t:x'], { key: 't:1', position: 'after' })).toEqual([]);
    expect(planMove(tree, ['t:1'], { key: 't:x', position: 'after' })).toEqual([]);
    expect(planMove(tree, ['t:1'], { key: 'w:h', position: 'inside' })).toEqual([]);
  });
});

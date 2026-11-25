import { describe, expect, it } from 'vitest';
import {
  allRowKeys,
  fromStoredCollapse,
  isGroupCollapsed,
  pruneCollapse,
  setWindowCollapsed,
  toStoredCollapse,
  toggleGroup,
  visibleRowKeys,
  withLocalExpansion,
  type CollapseState,
} from '../visibleRows';
import { buildTree } from '../buildTree';
import type { GroupNode, TabNode, WindowNode } from '../types';
import { group as groupRec, state, tab, win } from './outlineState';

// Window 1: [g:5, collapsed in Chrome (1, 2)] 3 ; Window 2: 4
const tree: WindowNode[] = buildTree(
  state({
    windows: [
      win('1', {
        chromeWindowId: 1,
        groups: [groupRec('5', { chromeGroupId: 5, collapsed: true })],
        tabs: [
          tab('1', { chromeTabId: 1, groupId: '5' }),
          tab('2', { chromeTabId: 2, groupId: '5' }),
          tab('3', { chromeTabId: 3 }),
        ],
      }),
      win('2', { chromeWindowId: 2, tabs: [tab('4', { chromeTabId: 4 })] }),
    ],
  }),
).windows;
const none: CollapseState = { collapsedWindows: new Set(), groupOverrides: new Map() };

describe('visibleRowKeys', () => {
  it('hides tabs of a group Chrome reports collapsed', () => {
    expect(visibleRowKeys(tree, none)).toEqual(['w:1', 'g:5', 't:3', 'w:2', 't:4']);
  });
  it('a local override expands a Chrome-collapsed group', () => {
    const c = {
      ...none,
      groupOverrides: new Map([['g:5', { collapsed: false, chromeCollapsed: true }]]),
    };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'g:5', 't:1', 't:2', 't:3', 'w:2', 't:4']);
  });
  it('a collapsed window shows only its header', () => {
    const c = { ...none, collapsedWindows: new Set(['w:1']) };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'w:2', 't:4']);
  });
  it('allRowKeys includes hidden rows', () => {
    expect(allRowKeys(tree)).toEqual(new Set(['w:1', 'g:5', 't:1', 't:2', 't:3', 'w:2', 't:4']));
  });
});

describe('group collapse overrides', () => {
  const t1: TabNode = {
    kind: 'tab',
    key: 't:1',
    id: '1',
    title: '',
    url: '',
    active: false,
    discarded: false,
    hibernated: true,
  };
  const group = (chromeCollapsed: boolean) => ({
    kind: 'group' as const,
    key: 'g:5',
    id: '5',
    title: 'G',
    color: 'blue' as const,
    chromeCollapsed,
    hibernated: true,
    tabs: [t1],
  });
  const win = (g: ReturnType<typeof group>): WindowNode[] => [{ ...tree[1]!, children: [g] }];

  it('a local toggle wins until Chrome changes its own collapsed flag, then Chrome wins', () => {
    const expanded = group(false);
    let c = toggleGroup(expanded, none);
    expect(isGroupCollapsed(expanded, c)).toBe(true);

    // Chrome collapses the group: the override was made against "expanded", so it is dropped.
    const collapsed = group(true);
    expect(isGroupCollapsed(collapsed, c)).toBe(true);
    c = pruneCollapse(win(collapsed), c);
    expect(c.groupOverrides.size).toBe(0);

    // Chrome expands it again: the view mirrors Chrome, the old override does not come back.
    expect(isGroupCollapsed(expanded, c)).toBe(false);
  });

  it('keeps an override while Chrome has not changed its flag', () => {
    const c = toggleGroup(group(true), none);
    expect(isGroupCollapsed(group(true), c)).toBe(false);
    expect(pruneCollapse(win(group(true)), c)).toBe(c);
  });
});

describe('pruneCollapse', () => {
  it('forgets windows and groups the outline no longer holds, and keeps the rest', () => {
    const c: CollapseState = {
      collapsedWindows: new Set(['w:1', 'w:gone']),
      groupOverrides: new Map([
        ['g:5', { collapsed: false, chromeCollapsed: true }],
        ['g:gone', { collapsed: true, chromeCollapsed: false }],
      ]),
    };
    const pruned = pruneCollapse(tree, c);
    expect([...pruned.collapsedWindows]).toEqual(['w:1']);
    expect([...pruned.groupOverrides.keys()]).toEqual(['g:5']);
    // Nothing left to drop: the same state back, so nothing is saved again.
    expect(pruneCollapse(tree, pruned)).toBe(pruned);
  });
});

describe('local expansion', () => {
  it('shows a window and a group expanded in this view only, over the shared state', () => {
    const shared = setWindowCollapsed(none, 'w:1', true);
    expect(visibleRowKeys(tree, shared)).toEqual(['w:1', 'w:2', 't:4']);
    const shown = withLocalExpansion(shared, {
      windows: new Set(['w:1']),
      groups: new Map([['g:5', { collapsed: false, chromeCollapsed: true }]]),
    });
    expect(visibleRowKeys(tree, shown)).toEqual(['w:1', 'g:5', 't:1', 't:2', 't:3', 'w:2', 't:4']);
    expect(shared.collapsedWindows.has('w:1')).toBe(true);
  });
});

describe('stored collapse state', () => {
  it('round-trips, and reads malformed storage as nothing collapsed', () => {
    const c = toggleGroup(tree[0]!.children[0] as GroupNode, setWindowCollapsed(none, 'w:2', true));
    const back = fromStoredCollapse(JSON.parse(JSON.stringify(toStoredCollapse(c))));
    expect(back).toEqual(c);
    expect(fromStoredCollapse(undefined)).toEqual(none);
    expect(fromStoredCollapse({ windows: [3], groups: { 'g:5': { collapsed: 'yes' } } })).toEqual(
      none,
    );
  });
});

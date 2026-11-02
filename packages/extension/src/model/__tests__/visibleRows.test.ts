import { describe, expect, it } from 'vitest';
import {
  allRowKeys,
  discardStaleOverrides,
  isGroupCollapsed,
  toggleGroup,
  visibleRowKeys,
  type CollapseState,
} from '../visibleRows';
import type { WindowNode } from '../types';

const t = (id: number) => ({
  kind: 'tab' as const,
  key: `t:${id}`,
  tabId: id,
  windowId: 1,
  title: '',
  url: '',
  active: false,
  discarded: false,
});
const tree: WindowNode[] = [
  {
    kind: 'window',
    key: 'w:1',
    windowId: 1,
    label: 'Window 1',
    focused: false,
    tabCount: 3,
    children: [
      {
        kind: 'group',
        key: 'g:5',
        groupId: 5,
        title: 'G',
        color: 'blue',
        chromeCollapsed: true,
        tabs: [t(1), t(2)],
      },
      t(3),
    ],
  },
  {
    kind: 'window',
    key: 'w:2',
    windowId: 2,
    label: 'Window 2',
    focused: false,
    tabCount: 1,
    children: [t(4)],
  },
];
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
  const group = (chromeCollapsed: boolean) => ({
    kind: 'group' as const,
    key: 'g:5',
    groupId: 5,
    title: 'G',
    color: 'blue' as const,
    chromeCollapsed,
    tabs: [t(1)],
  });
  const win = (g: ReturnType<typeof group>): WindowNode[] => [{ ...tree[1]!, children: [g] }];

  it('a local toggle wins until Chrome changes its own collapsed flag, then Chrome wins', () => {
    const expanded = group(false);
    let c = toggleGroup(expanded, none);
    expect(isGroupCollapsed(expanded, c)).toBe(true);

    // Chrome collapses the group: the override was made against "expanded", so it is dropped.
    const collapsed = group(true);
    expect(isGroupCollapsed(collapsed, c)).toBe(true);
    c = discardStaleOverrides(win(collapsed), c);
    expect(c.groupOverrides.size).toBe(0);

    // Chrome expands it again: the view mirrors Chrome, the old override does not come back.
    expect(isGroupCollapsed(expanded, c)).toBe(false);
  });

  it('keeps an override while Chrome has not changed its flag', () => {
    const c = toggleGroup(group(true), none);
    expect(isGroupCollapsed(group(true), c)).toBe(false);
    expect(discardStaleOverrides(win(group(true)), c)).toBe(c);
  });
});

import { describe, expect, it } from 'vitest';
import { allRowKeys, visibleRowKeys, type CollapseState } from '../visibleRows';
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
        key: 'g:5:1',
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
    expect(visibleRowKeys(tree, none)).toEqual(['w:1', 'g:5:1', 't:3', 'w:2', 't:4']);
  });
  it('a local override expands a Chrome-collapsed group', () => {
    const c = { ...none, groupOverrides: new Map([['g:5:1', false]]) };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'g:5:1', 't:1', 't:2', 't:3', 'w:2', 't:4']);
  });
  it('a collapsed window shows only its header', () => {
    const c = { ...none, collapsedWindows: new Set(['w:1']) };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'w:2', 't:4']);
  });
  it('allRowKeys includes hidden rows', () => {
    expect(allRowKeys(tree)).toEqual(new Set(['w:1', 'g:5:1', 't:1', 't:2', 't:3', 'w:2', 't:4']));
  });
});

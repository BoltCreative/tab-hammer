import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { activeTabOf, currentTabsNavRows, currentTabsTree, recenterTarget } from '../currentTabs';
import { filterTree } from '../filterTree';
import { navIntent, outlineRows, viewShortcut, type KeyPress } from '../keyboardNav';
import type { WindowNode } from '../types';
import { EXPAND_ALL } from '../visibleRows';
import { group, state, tab, win } from './outlineState';

// Window 1 (live): [Reading (1, 2*)] 3 ; Window 2 (live): 4 5* ; Window 3 (hibernated): [Trips (6)]
// (* active)
function layout(): WindowNode[] {
  const t = (id: number, title: string, groupId?: string) =>
    tab(`${id}`, { chromeTabId: id, title, url: `https://${id}.test/`, groupId });
  return buildTree(
    state({
      windows: [
        win('1', {
          chromeWindowId: 1,
          groups: [group('10', { chromeGroupId: 10, title: 'Reading', collapsed: true })],
          tabs: [t(1, 'Rust book', '10'), t(2, 'Cargo guide', '10'), t(3, 'Weather')],
        }),
        win('2', { chromeWindowId: 2, tabs: [t(4, 'Inbox'), t(5, 'Calendar')] }),
        win('3', {
          groups: [group('30', { title: 'Trips' })],
          tabs: [tab('6', { title: 'Lisbon flights', url: 'https://fly.test/', groupId: '30' })],
        }),
      ],
      live: { tabs: { 2: { active: true }, 5: { active: true } } },
    }),
  ).windows;
}

const shape = (tree: WindowNode[]) =>
  tree.map((w) => [w.key, w.children.map((c) => c.key)] as const);

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  alt: false,
  mod: false,
  otherMod: false,
  ...mods,
});

describe('currentTabsTree', () => {
  it('shows each live window its active tab only, out of its group, and hibernated windows bare', () => {
    expect(shape(currentTabsTree(layout()))).toEqual([
      ['w:1', ['t:2']],
      ['w:2', ['t:5']],
      ['w:3', []],
    ]);
  });

  it('follows the active tab when it changes', () => {
    const before = layout();
    const after = buildTree(
      state({
        windows: [win('2', { chromeWindowId: 2, tabs: [tab('4', { chromeTabId: 4 })] })],
        live: { tabs: { 4: { active: true } } },
      }),
    ).windows;
    expect(activeTabOf(before[1]!)?.key).toBe('t:5');
    expect(shape(currentTabsTree(after))).toEqual([['w:2', ['t:4']]]);
  });

  it('keeps window counts and identities, so headers read the same', () => {
    const shown = currentTabsTree(layout());
    expect(shown.map((w) => w.tabCount)).toEqual([3, 2, 1]);
  });

  it('is overridden by search: filtering the whole tree finds non-active tabs', () => {
    // The view filters the whole tree while a query is set, never the current-tabs one.
    const tree = layout();
    expect(shape(filterTree(tree, 'inbox'))).toEqual([['w:2', ['t:4']]]);
    expect(shape(filterTree(currentTabsTree(tree), 'inbox'))).toEqual([]);
  });
});

describe('currentTabsNavRows', () => {
  const rows = () => currentTabsNavRows(outlineRows(currentTabsTree(layout()), EXPAND_ALL));

  it('steps ↑/↓ through current tabs, keeping headers only for windows with none', () => {
    expect(rows().map((r) => r.key)).toEqual(['t:2', 't:5', 'w:3']);
    expect(navIntent(rows(), 't:2', press('ArrowDown'))).toEqual({
      type: 'move',
      key: 't:5',
      extend: false,
    });
    expect(navIntent(rows(), null, press('ArrowDown'))).toMatchObject({ key: 't:2' });
  });

  it('Enter and ⌘↓ activate the current tab; ⌘↑ has nowhere to go', () => {
    expect(navIntent(rows(), 't:5', press('Enter'))).toEqual({ type: 'activate', key: 't:5' });
    expect(navIntent(rows(), 't:5', press('ArrowDown', { mod: true }))).toEqual({
      type: 'activate',
      key: 't:5',
    });
    expect(navIntent(rows(), 't:5', press('ArrowUp', { mod: true }))).toBeNull();
  });

  it('⌥↑/↓ still moves the window under the cursor', () => {
    expect(navIntent(rows(), 't:5', press('ArrowUp', { alt: true }))).toEqual({
      type: 'moveWindow',
      key: 't:5',
      delta: -1,
    });
  });
});

describe('recenterTarget', () => {
  const none = { collapsedWindows: new Set<string>(), groupOverrides: new Map() };

  it("lands on the window's active tab, expanding its collapsed group", () => {
    const [w1] = layout();
    const t = recenterTarget(w1!, none);
    expect(t.key).toBe('t:2');
    expect(t.expandWindow).toBe(false);
    expect(t.expandGroup?.key).toBe('g:10');
  });

  it('expands a collapsed window', () => {
    const [, w2] = layout();
    expect(recenterTarget(w2!, { ...none, collapsedWindows: new Set(['w:2']) })).toEqual({
      key: 't:5',
      expandWindow: true,
      expandGroup: undefined,
    });
  });

  it('lands on the header of a window with no live tab', () => {
    const [, , w3] = layout();
    expect(recenterTarget(w3!, none)).toEqual({
      key: 'w:3',
      expandWindow: false,
      expandGroup: undefined,
    });
  });
});

describe('viewShortcut', () => {
  it('maps ⌘/ and ⌘\\ only, without other modifiers', () => {
    expect(viewShortcut(press('/', { mod: true }))).toBe('currentTabs');
    expect(viewShortcut(press('\\', { mod: true }))).toBe('recenter');
    expect(viewShortcut(press('/'))).toBeNull();
    expect(viewShortcut(press('/', { mod: true, shift: true }))).toBeNull();
    expect(viewShortcut(press('\\', { mod: true, otherMod: true }))).toBeNull();
  });
});

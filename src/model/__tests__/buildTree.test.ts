import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import type { RawGroup, RawSnapshot, RawTab } from '../types';

const tab = (id: number, windowId: number, index: number, extra: Partial<RawTab> = {}): RawTab => ({
  id,
  windowId,
  index,
  groupId: -1,
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
  active: false,
  discarded: false,
  ...extra,
});

const group = (id: number, windowId: number, extra: Partial<RawGroup> = {}): RawGroup => ({
  id,
  windowId,
  title: `Group ${id}`,
  color: 'blue',
  collapsed: false,
  ...extra,
});

const snap = (s: Partial<RawSnapshot>): RawSnapshot => ({
  windows: [],
  tabs: [],
  groups: [],
  selfWindowId: null,
  lastFocusedWindowId: null,
  ...s,
});

describe('buildTree', () => {
  it('lists windows in given order with 1-based labels, tabs sorted by index', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }, { id: 20 }],
        tabs: [tab(2, 10, 1), tab(1, 10, 0), tab(3, 20, 0)],
        lastFocusedWindowId: 20,
      }),
    );
    expect(tree.map((w) => [w.label, w.focused, w.tabCount])).toEqual([
      ['Window 1', false, 2],
      ['Window 2', true, 1],
    ]);
    expect(tree[0]!.children.map((c) => c.key)).toEqual(['t:1', 't:2']);
  });

  it('excludes the Tab Hammer window and renumbers the rest', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 99 }, { id: 10 }],
        tabs: [tab(1, 99, 0), tab(2, 10, 0)],
        selfWindowId: 99,
      }),
    );
    expect(tree.map((w) => [w.windowId, w.label])).toEqual([[10, 'Window 1']]);
  });

  it('wraps consecutive grouped tabs in a GroupNode, keeping ungrouped tabs at top level', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [tab(1, 10, 0, { groupId: 5 }), tab(2, 10, 1, { groupId: 5 }), tab(3, 10, 2)],
        groups: [group(5, 10, { title: 'Research', color: 'red', collapsed: true })],
      }),
    );
    const [g, t] = tree[0]!.children;
    expect(g).toMatchObject({
      kind: 'group',
      key: 'g:5',
      title: 'Research',
      color: 'red',
      chromeCollapsed: true,
    });
    expect(g!.kind === 'group' && g!.tabs.map((x) => x.key)).toEqual(['t:1', 't:2']);
    expect(t).toMatchObject({ kind: 'tab', key: 't:3' });
    expect(tree[0]!.tabCount).toBe(3);
  });

  it('gives each run of a split group its own GroupNode with a unique key', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [
          tab(1, 10, 0, { groupId: 5 }),
          tab(2, 10, 1),
          tab(3, 10, 2, { groupId: 5 }),
          tab(4, 10, 3),
          tab(5, 10, 4, { groupId: 5 }),
        ],
        groups: [group(5, 10)],
      }),
    );
    expect(tree[0]!.children.map((c) => c.key)).toEqual(['g:5', 't:2', 'g:5#2', 't:4', 'g:5#3']);
  });

  it("keeps a group's key when its first tab closes or moves out", () => {
    const groups = [group(5, 10)];
    const before = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [tab(1, 10, 0, { groupId: 5 }), tab(2, 10, 1, { groupId: 5 })],
        groups,
      }),
    );
    const after = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [tab(2, 10, 0, { groupId: 5 }), tab(1, 10, 1)],
        groups,
      }),
    );
    expect(after[0]!.children[0]!.key).toBe(before[0]!.children[0]!.key);
    expect(before[0]!.children[0]!.key).toBe('g:5');
  });

  it('marks only the last-focused window (other than Tab Hammer) as focused', () => {
    const windows = [{ id: 99 }, { id: 10 }, { id: 20 }];
    const focusedIds = (lastFocusedWindowId: number | null) =>
      buildTree(snap({ windows, selfWindowId: 99, lastFocusedWindowId }))
        .filter((w) => w.focused)
        .map((w) => w.windowId);
    expect(focusedIds(10)).toEqual([10]);
    expect(focusedIds(null)).toEqual([]);
  });

  it('labels an untitled group and falls back from title to url to pendingUrl', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [
          tab(1, 10, 0, { groupId: 5, title: '', url: 'https://a.test/' }),
          tab(2, 10, 1, { title: undefined, url: undefined, pendingUrl: 'https://b.test/' }),
        ],
        groups: [group(5, 10, { title: '' })],
      }),
    );
    const [g, t] = tree[0]!.children;
    expect(g!.kind === 'group' && g!.title).toBe('Untitled group');
    expect(g!.kind === 'group' && g!.tabs[0]!.title).toBe('https://a.test/');
    expect(t!.kind === 'tab' && [t!.title, t!.url]).toEqual(['https://b.test/', 'https://b.test/']);
  });

  it('carries active and discarded flags', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [tab(1, 10, 0, { active: true }), tab(2, 10, 1, { discarded: true })],
      }),
    );
    expect(tree[0]!.children).toMatchObject([
      { active: true, discarded: false },
      { active: false, discarded: true },
    ]);
  });

  it('treats a tab whose group is missing from the snapshot as ungrouped', () => {
    const tree = buildTree(
      snap({
        windows: [{ id: 10 }],
        tabs: [tab(1, 10, 0, { groupId: 77 })],
      }),
    );
    expect(tree[0]!.children).toMatchObject([{ kind: 'tab', key: 't:1' }]);
  });
});

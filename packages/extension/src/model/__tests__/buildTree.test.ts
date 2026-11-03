import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { group, state, tab, win } from './outlineState';

describe('buildTree', () => {
  it('lists windows in outline order with their tabs, live details and focus', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', {
            chromeWindowId: 10,
            tabs: [tab('a', { chromeTabId: 1 }), tab('b', { chromeTabId: 2 })],
          }),
          win('w2', { chromeWindowId: 20, tabs: [tab('c', { chromeTabId: 3 })] }),
        ],
        live: { focusedWindowId: 20, tabs: { 1: { active: true, lastAccessed: 5 } } },
      }),
    );
    expect(windows.map((w) => [w.key, w.id, w.windowId, w.focused, w.tabCount])).toEqual([
      ['w:w1', 'w1', 10, false, 2],
      ['w:w2', 'w2', 20, true, 1],
    ]);
    expect(windows[0]!.children).toMatchObject([
      { kind: 'tab', key: 't:a', id: 'a', tabId: 1, windowId: 10, active: true, lastAccessed: 5 },
      { kind: 'tab', key: 't:b', tabId: 2, active: false, discarded: false, hibernated: false },
    ]);
  });

  it('labels windows by name or position', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', { chromeWindowId: 1 }),
          win('w2', { name: 'Work' }),
          win('gone', { state: 'trashed', closedAt: 1 }),
          win('w3', { chromeWindowId: 3 }),
        ],
      }),
    );
    expect(windows.map((w) => w.label)).toEqual(['Window 1', 'Work', 'Window 3']);
    expect(windows[1]!.name).toBe('Work');
  });

  it('wraps consecutive grouped tabs in a GroupNode, keeping ungrouped tabs at top level', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', {
            chromeWindowId: 10,
            groups: [
              group('g1', { chromeGroupId: 5, title: 'Research', color: 'red', collapsed: true }),
            ],
            tabs: [
              tab('a', { chromeTabId: 1, groupId: 'g1' }),
              tab('b', { chromeTabId: 2, groupId: 'g1' }),
              tab('c', { chromeTabId: 3 }),
            ],
          }),
        ],
      }),
    );
    const [g, t] = windows[0]!.children;
    expect(g).toMatchObject({
      kind: 'group',
      key: 'g:g1',
      id: 'g1',
      chromeGroupId: 5,
      title: 'Research',
      color: 'red',
      chromeCollapsed: true,
      hibernated: false,
    });
    expect(g!.kind === 'group' && g!.tabs.map((x) => x.key)).toEqual(['t:a', 't:b']);
    expect(t).toMatchObject({ kind: 'tab', key: 't:c' });
    expect(windows[0]!.tabCount).toBe(3);
  });

  it('gives each run of a split group its own GroupNode with a unique key', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', {
            chromeWindowId: 10,
            groups: [group('g1', { chromeGroupId: 5 })],
            tabs: [
              tab('a', { chromeTabId: 1, groupId: 'g1' }),
              tab('b', { chromeTabId: 2 }),
              tab('c', { chromeTabId: 3, groupId: 'g1' }),
              tab('d', { chromeTabId: 4 }),
              tab('e', { chromeTabId: 5, groupId: 'g1' }),
            ],
          }),
        ],
      }),
    );
    expect(windows[0]!.children.map((c) => c.key)).toEqual([
      'g:g1',
      't:b',
      'g:g1#2',
      't:d',
      'g:g1#3',
    ]);
  });

  it('hibernated tabs and groups are flagged', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', {
            groups: [group('g1', { title: 'Old' })],
            tabs: [tab('a', { groupId: 'g1' }), tab('b')],
          }),
          win('w2', { chromeWindowId: 2, tabs: [tab('c', { chromeTabId: 3 })] }),
        ],
      }),
    );
    const [w1, w2] = windows;
    expect(w1).toMatchObject({ hibernated: true, windowId: undefined, focused: false });
    expect(w1!.children).toMatchObject([
      { kind: 'group', hibernated: true, chromeGroupId: undefined },
      { kind: 'tab', hibernated: true, tabId: undefined, active: false, discarded: false },
    ]);
    expect(w2).toMatchObject({ hibernated: false, windowId: 2 });
    expect(w2!.children).toMatchObject([{ hibernated: false, tabId: 3 }]);
  });

  it('labels an untitled group and falls back from title to url', () => {
    const { windows } = buildTree(
      state({
        windows: [
          win('w1', {
            chromeWindowId: 10,
            groups: [group('g1', { title: '' })],
            tabs: [tab('a', { chromeTabId: 1, groupId: 'g1', title: '', url: 'https://a.test/' })],
          }),
        ],
      }),
    );
    const [g] = windows[0]!.children;
    expect(g!.kind === 'group' && g!.title).toBe('Untitled group');
    expect(g!.kind === 'group' && g!.tabs[0]!.title).toBe('https://a.test/');
  });

  it('carries the discarded flag', () => {
    const { windows } = buildTree(
      state({
        windows: [win('w1', { chromeWindowId: 10, tabs: [tab('a', { chromeTabId: 1 })] })],
        live: { tabs: { 1: { discarded: true } } },
      }),
    );
    expect(windows[0]!.children).toMatchObject([{ active: false, discarded: true }]);
  });

  it('treats a tab whose group is missing from its window as ungrouped', () => {
    const { windows } = buildTree(
      state({
        windows: [win('w1', { chromeWindowId: 10, tabs: [tab('a', { groupId: 'nope' })] })],
      }),
    );
    expect(windows[0]!.children).toMatchObject([{ kind: 'tab', key: 't:a' }]);
  });

  it('trash entries are newest first and labelled by name or first tab', () => {
    const view = buildTree(
      state({
        windows: [
          win('old', { state: 'trashed', closedAt: 100, tabs: [tab('a', { title: 'Alpha' })] }),
          win('live', { chromeWindowId: 1 }),
          win('new', { state: 'trashed', closedAt: 300, name: 'Trip', tabs: [tab('b')] }),
          win('mid', { state: 'trashed', closedAt: 200, tabs: [tab('c', { title: '' })] }),
        ],
      }),
    );
    expect(view.windows.map((w) => w.key)).toEqual(['w:live']);
    expect(view.trash.map((w) => [w.key, w.label, w.closedAt, w.hibernated])).toEqual([
      ['w:new', 'Trip', 300, true],
      ['w:mid', 'https://e.test/c', 200, true],
      ['w:old', 'Alpha', 100, true],
    ]);
  });
});

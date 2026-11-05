import { describe, expect, it } from 'vitest';
import { emptySelection, selectionReducer as r, type SelectionState } from '../selection';
import { visibleRowKeys, type CollapseState } from '../visibleRows';
import { buildTree } from '../buildTree';
import type { WindowNode } from '../types';
import { group, state, tab, win } from './outlineState';

const keys = (s: SelectionState) => [...s.selected].sort();
const visible = ['w:1', 't:1', 't:2', 't:3', 'w:2', 't:4'];

describe('selectionReducer', () => {
  it('click selects only that row and sets the anchor', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:1' }), { type: 'click', key: 't:2' });
    expect(keys(s)).toEqual(['t:2']);
    expect(s.anchor).toBe('t:2');
  });
  it('toggle adds and removes without clearing others', () => {
    let s = r(emptySelection, { type: 'click', key: 't:1' });
    s = r(s, { type: 'toggle', key: 't:3' });
    expect(keys(s)).toEqual(['t:1', 't:3']);
    s = r(s, { type: 'toggle', key: 't:1' });
    expect(keys(s)).toEqual(['t:3']);
    expect(s.anchor).toBe('t:1');
  });
  it('range selects visible rows between anchor and target, in either direction', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:3' }), {
      type: 'range',
      key: 't:1',
      visible,
    });
    expect(keys(s)).toEqual(['t:1', 't:2', 't:3']);
    expect(s.anchor).toBe('t:3');
  });
  it('range can span windows', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:2' }), {
      type: 'range',
      key: 't:4',
      visible,
    });
    expect(keys(s)).toEqual(['t:2', 't:3', 't:4', 'w:2']);
  });
  it('range with no visible anchor behaves like click', () => {
    const s = r(emptySelection, { type: 'range', key: 't:2', visible });
    expect(keys(s)).toEqual(['t:2']);
    expect(s.anchor).toBe('t:2');
  });
  it('prune drops keys that no longer exist and clears a vanished anchor', () => {
    let s = r(emptySelection, { type: 'click', key: 't:1' });
    s = r(s, { type: 'toggle', key: 't:2' });
    s = r(s, { type: 'prune', existing: new Set(['t:1']) });
    expect(keys(s)).toEqual(['t:1']);
    expect(s.anchor).toBeNull();
  });
  it('prune returns the same object when nothing changed', () => {
    const s = r(emptySelection, { type: 'click', key: 't:1' });
    expect(r(s, { type: 'prune', existing: new Set(['t:1']) })).toBe(s);
  });
});

describe('range selection across a collapsed node', () => {
  it('range across a collapsed group selects only visible rows, not hidden tabs', () => {
    const tree: WindowNode[] = buildTree(
      state({
        windows: [
          win('1', {
            chromeWindowId: 1,
            groups: [group('5', { chromeGroupId: 5, collapsed: true })],
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

    const c: CollapseState = {
      collapsedWindows: new Set(),
      groupOverrides: new Map(),
    };
    const visible = visibleRowKeys(tree, c);
    // visible should be: ['w:1', 'g:5', 't:3', 'w:2', 't:4']

    // Click on window header, shift-range to a tab after the collapsed group
    const s = r(r(emptySelection, { type: 'click', key: 'w:1' }), {
      type: 'range',
      key: 't:4',
      visible,
    });

    // Should include window headers and visible tabs, but NOT hidden tabs t:1, t:2
    expect(keys(s)).toEqual(['g:5', 't:3', 't:4', 'w:1', 'w:2']);
    expect(s.selected.has('t:1')).toBe(false);
    expect(s.selected.has('t:2')).toBe(false);
  });
});

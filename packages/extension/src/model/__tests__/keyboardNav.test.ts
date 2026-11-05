import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { navIntent, outlineRows } from '../keyboardNav';
import { EXPAND_ALL, type CollapseState } from '../visibleRows';
import { group, state, tab, win } from './outlineState';

// Window 1: [g:10 (1, 2)] 3 ; Window 2: 4
const tree = buildTree(
  state({
    windows: [
      win('1', {
        chromeWindowId: 1,
        groups: [group('10', { chromeGroupId: 10 })],
        tabs: [
          tab('1', { chromeTabId: 1, groupId: '10' }),
          tab('2', { chromeTabId: 2, groupId: '10' }),
          tab('3', { chromeTabId: 3 }),
        ],
      }),
      win('2', { chromeWindowId: 2, tabs: [tab('4', { chromeTabId: 4 })] }),
    ],
  }),
).windows;
const open: CollapseState = { collapsedWindows: new Set(), groupOverrides: new Map() };
const rows = outlineRows(tree, open);

describe('outlineRows', () => {
  it('lists visible rows with level, parent, expanded state and position in their set', () => {
    expect(rows.map((r) => [r.key, r.level, r.parent, r.expanded, r.posInSet, r.setSize])).toEqual([
      ['w:1', 1, null, true, 1, 2],
      ['g:10', 2, 'w:1', true, 1, 2],
      ['t:1', 3, 'g:10', undefined, 1, 2],
      ['t:2', 3, 'g:10', undefined, 2, 2],
      ['t:3', 2, 'w:1', undefined, 2, 2],
      ['w:2', 1, null, true, 2, 2],
      ['t:4', 2, 'w:2', undefined, 1, 1],
    ]);
  });

  it('skips the children of collapsed rows', () => {
    const c = { ...open, collapsedWindows: new Set(['w:1']) };
    expect(outlineRows(tree, c).map((r) => r.key)).toEqual(['w:1', 'w:2', 't:4']);
    expect(outlineRows(tree, c)[0]!.expanded).toBe(false);
  });

  it('marks nothing collapsible while everything is forced open', () => {
    expect(outlineRows(tree, EXPAND_ALL).every((r) => r.expanded === undefined)).toBe(true);
  });
});

describe('navIntent', () => {
  it('moves up and down, stopping at the ends, and Shift extends', () => {
    expect(navIntent(rows, 't:1', 'ArrowDown', false)).toEqual({
      type: 'move',
      key: 't:2',
      extend: false,
    });
    expect(navIntent(rows, 't:1', 'ArrowUp', true)).toEqual({
      type: 'move',
      key: 'g:10',
      extend: true,
    });
    expect(navIntent(rows, 't:4', 'ArrowDown', false)).toBeNull();
    expect(navIntent(rows, 'w:1', 'ArrowUp', false)).toBeNull();
    expect(navIntent(rows, 't:1', 'End', false)).toMatchObject({ key: 't:4' });
    expect(navIntent(rows, 't:1', 'Home', false)).toMatchObject({ key: 'w:1' });
  });

  it('starts on the first row when there is no cursor', () => {
    expect(navIntent(rows, null, 'ArrowDown', false)).toMatchObject({ key: 'w:1' });
    expect(navIntent(rows, 'gone', 'ArrowUp', false)).toMatchObject({ key: 'w:1' });
    expect(navIntent(rows, null, 'Enter', false)).toBeNull();
  });

  it('Right expands a collapsed row, else steps to its first child', () => {
    const collapsed = outlineRows(tree, { ...open, collapsedWindows: new Set(['w:1']) });
    expect(navIntent(collapsed, 'w:1', 'ArrowRight', false)).toEqual({
      type: 'toggleExpand',
      key: 'w:1',
    });
    expect(navIntent(rows, 'w:1', 'ArrowRight', false)).toMatchObject({ key: 'g:10' });
    expect(navIntent(rows, 't:3', 'ArrowRight', false)).toBeNull();
  });

  it('Left collapses an expanded row, else steps to the parent', () => {
    expect(navIntent(rows, 'g:10', 'ArrowLeft', false)).toEqual({
      type: 'toggleExpand',
      key: 'g:10',
    });
    expect(navIntent(rows, 't:2', 'ArrowLeft', false)).toEqual({
      type: 'move',
      key: 'g:10',
      extend: false,
    });
    const forced = outlineRows(tree, EXPAND_ALL);
    expect(navIntent(forced, 'g:10', 'ArrowLeft', false)).toMatchObject({ key: 'w:1' });
  });

  it('Enter activates and Space toggles the selection', () => {
    expect(navIntent(rows, 't:3', 'Enter', false)).toEqual({ type: 'activate', key: 't:3' });
    expect(navIntent(rows, 't:3', ' ', false)).toEqual({ type: 'toggleSelect', key: 't:3' });
    expect(navIntent(rows, 't:3', 'x', false)).toBeNull();
  });

  it('Delete and Backspace mean trash the cursor row', () => {
    expect(navIntent(rows, 't:3', 'Delete', false)).toEqual({ type: 'trash', key: 't:3' });
    expect(navIntent(rows, 'w:1', 'Backspace', false)).toEqual({ type: 'trash', key: 'w:1' });
  });
});

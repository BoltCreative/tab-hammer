import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import {
  TRASH_SECTION_KEY,
  keyPressOf,
  navIntent,
  outlineRows,
  trashRows,
  typesIntoSearch,
  type KeyPress,
} from '../keyboardNav';
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

const k = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  alt: false,
  mod: false,
  otherMod: false,
  ...mods,
});
const cmd = { mod: true };

describe('navIntent', () => {
  it('Up and Down move the cursor, stopping at the ends, and Shift extends', () => {
    expect(navIntent(rows, 't:1', k('ArrowDown'))).toEqual({
      type: 'move',
      key: 't:2',
      extend: false,
    });
    expect(navIntent(rows, 't:1', k('ArrowUp', { shift: true }))).toEqual({
      type: 'move',
      key: 'g:10',
      extend: true,
    });
    expect(navIntent(rows, 't:4', k('ArrowDown'))).toBeNull();
    expect(navIntent(rows, 'w:1', k('ArrowUp'))).toBeNull();
  });

  it('starts on the first row (↓) or the last (↑) when there is no cursor', () => {
    expect(navIntent(rows, null, k('ArrowDown'))).toMatchObject({ key: 'w:1' });
    expect(navIntent(rows, 'gone', k('ArrowUp'))).toMatchObject({ key: 't:4' });
    expect(navIntent(rows, null, k('Enter'))).toBeNull();
    expect(navIntent(rows, null, k('ArrowDown', cmd))).toBeNull();
  });

  it('leaves text-editing keys to the search box', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Backspace', 'Delete', 'x']) {
      expect(navIntent(rows, 't:3', k(key))).toBeNull();
    }
    expect(navIntent(rows, 't:3', k('ArrowLeft', cmd))).toBeNull();
    expect(navIntent(rows, 't:3', k('a', cmd))).toBeNull();
  });

  it('⌘↓ expands a collapsed row, steps into an open one, and activates a tab', () => {
    const collapsed = outlineRows(tree, { ...open, collapsedWindows: new Set(['w:1']) });
    expect(navIntent(collapsed, 'w:1', k('ArrowDown', cmd))).toEqual({
      type: 'toggleExpand',
      key: 'w:1',
    });
    expect(navIntent(rows, 'w:1', k('ArrowDown', cmd))).toEqual({
      type: 'move',
      key: 'g:10',
      extend: false,
    });
    expect(navIntent(rows, 't:3', k('ArrowDown', cmd))).toEqual({ type: 'activate', key: 't:3' });
    // Searching forces everything open: a window still steps into its children.
    expect(navIntent(outlineRows(tree, EXPAND_ALL), 'w:2', k('ArrowDown', cmd))).toMatchObject({
      key: 't:4',
    });
  });

  it('⌘↑ collapses an open row, else steps out to the parent', () => {
    expect(navIntent(rows, 'g:10', k('ArrowUp', cmd))).toEqual({
      type: 'toggleExpand',
      key: 'g:10',
    });
    expect(navIntent(rows, 't:2', k('ArrowUp', cmd))).toEqual({
      type: 'move',
      key: 'g:10',
      extend: false,
    });
    const forced = outlineRows(tree, EXPAND_ALL);
    expect(navIntent(forced, 'g:10', k('ArrowUp', cmd))).toMatchObject({ key: 'w:1' });
    expect(navIntent(forced, 'w:1', k('ArrowUp', cmd))).toBeNull();
  });

  it('⌥↑/↓ move the cursor’s window', () => {
    expect(navIntent(rows, 't:1', k('ArrowDown', { alt: true }))).toEqual({
      type: 'moveWindow',
      key: 't:1',
      delta: 1,
    });
    expect(navIntent(rows, 'w:2', k('ArrowUp', { alt: true }))).toMatchObject({ delta: -1 });
    expect(navIntent(rows, null, k('ArrowUp', { alt: true }))).toBeNull();
  });

  it('Enter opens the cursor row; ⌘⌫ trashes it, and plain Backspace or Delete does not', () => {
    expect(navIntent(rows, 't:3', k('Enter'))).toEqual({ type: 'activate', key: 't:3' });
    expect(navIntent(rows, 'w:1', k('Backspace', cmd))).toEqual({ type: 'trash', key: 'w:1' });
    expect(navIntent(rows, 'w:1', k('Backspace'))).toBeNull();
    expect(navIntent(rows, 'w:1', k('Delete', cmd))).toBeNull();
  });

  it('ignores the platform’s other modifier (Ctrl on a Mac)', () => {
    expect(navIntent(rows, 't:1', k('ArrowDown', { otherMod: true }))).toBeNull();
    expect(navIntent(rows, 't:1', k('Backspace', { otherMod: true, mod: true }))).toBeNull();
  });

  describe('Recently closed', () => {
    const closed = buildTree(
      state({
        windows: [
          win('9', {
            state: 'trashed',
            tabs: [tab('91'), tab('92')],
          }),
        ],
      }),
    ).trash;
    const all = [...rows, ...trashRows(closed, true, new Set(['w:9']))];

    it('lists the section, its closed windows and expanded tabs after the outline', () => {
      expect(all.slice(rows.length).map((r) => [r.key, r.parent, r.expanded])).toEqual([
        [TRASH_SECTION_KEY, null, true],
        ['w:9', TRASH_SECTION_KEY, true],
        ['t:91', 'w:9', undefined],
        ['t:92', 'w:9', undefined],
      ]);
      expect(trashRows(closed, false, new Set()).map((r) => r.key)).toEqual([TRASH_SECTION_KEY]);
      expect(trashRows([], true, new Set())).toEqual([]);
    });

    it('the cursor runs on into it, but never extends the selection there or trashes', () => {
      expect(navIntent(all, 't:4', k('ArrowDown', { shift: true }))).toEqual({
        type: 'move',
        key: TRASH_SECTION_KEY,
        extend: false,
      });
      expect(navIntent(all, 'w:9', k('ArrowUp', cmd))).toEqual({
        type: 'toggleExpand',
        key: 'w:9',
      });
      expect(navIntent(all, 't:91', k('ArrowUp', cmd))).toMatchObject({ key: 'w:9' });
      expect(navIntent(all, 'w:9', k('Backspace', cmd))).toBeNull();
      expect(navIntent(all, 'w:9', k('ArrowDown', { alt: true }))).toBeNull();
      expect(navIntent(all, 'w:9', k('Enter'))).toEqual({ type: 'activate', key: 'w:9' });
    });
  });
});

describe('keyPressOf', () => {
  const e = { key: 'ArrowDown', shiftKey: false, altKey: false, metaKey: true, ctrlKey: false };
  it('reads ⌘ as the command key on a Mac and Ctrl elsewhere', () => {
    expect(keyPressOf(e, true)).toMatchObject({ mod: true, otherMod: false });
    expect(keyPressOf(e, false)).toMatchObject({ mod: false, otherMod: true });
    expect(keyPressOf({ ...e, metaKey: false, ctrlKey: true }, false)).toMatchObject({
      mod: true,
      otherMod: false,
    });
  });
});

describe('typesIntoSearch', () => {
  const press = (key: string, mods: Partial<Parameters<typeof typesIntoSearch>[0]> = {}) =>
    typesIntoSearch({
      key,
      metaKey: false,
      ctrlKey: false,
      altGraph: false,
      isComposing: false,
      ...mods,
    });
  it('is printable characters, dead keys, IME composition and Backspace', () => {
    for (const key of ['a', 'Z', '7', ' ', 'é', '∂', '😀', 'Dead', 'Process', 'Backspace']) {
      expect(press(key), key).toBe(true);
    }
    expect(press('Unidentified', { isComposing: true })).toBe(true);
  });
  it('is not navigation, Enter, Escape or a ⌘/Ctrl combo, though AltGr types', () => {
    for (const key of ['ArrowDown', 'Enter', 'Escape', 'Tab', 'Shift', 'F5']) {
      expect(press(key), key).toBe(false);
    }
    expect(press('f', { metaKey: true })).toBe(false);
    expect(press('w', { ctrlKey: true })).toBe(false);
    expect(press('@', { ctrlKey: true, altGraph: true })).toBe(true);
  });
});

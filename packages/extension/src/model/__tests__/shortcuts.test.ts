import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { navIntent, outlineRows, viewShortcut, type KeyPress } from '../keyboardNav';
import { cheatSheet, comboLabel, shortcutOf, SHORTCUTS } from '../shortcuts';
import type { CollapseState } from '../visibleRows';
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
const collapsed = outlineRows(tree, { ...open, collapsedWindows: new Set(['w:1']) });

// Enough outline situations that every outline key has something to do in one of them.
const situations: [typeof rows, string | null][] = [
  [rows, null],
  [rows, 'w:1'],
  [rows, 'g:10'],
  [rows, 't:2'],
  [rows, 't:4'],
  [collapsed, 'w:1'],
];

/**
 * Whether the view's key handlers act on a press in some situation: the outline's (`navIntent`),
 * the view's own ⌘ keys (`viewShortcut`), or App's Escape.
 */
const handled = (p: KeyPress) =>
  viewShortcut(p) !== null ||
  shortcutOf(p) === 'escape' ||
  situations.some(([r, cursor]) => navIntent(r, cursor, p) !== null);

// Every key the table uses, plus text-editing keys and lookalikes the handlers must leave alone.
const KEYS = [
  ...new Set(SHORTCUTS.flatMap((s) => s.combos.map((c) => c.key))),
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Delete',
  'Tab',
  ' ',
  'a',
  '?',
  ';',
  '.',
  'F1',
];
const presses: KeyPress[] = KEYS.flatMap((key) =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((m) => ({
    key,
    shift: (m & 1) !== 0,
    alt: (m & 2) !== 0,
    mod: (m & 4) !== 0,
    otherMod: (m & 8) !== 0,
  })),
);

describe('the shortcut table', () => {
  for (const mac of [true, false]) {
    it(`lists exactly the keys the handlers act on (${mac ? 'Mac' : 'Windows/Linux'})`, () => {
      const listed = new Set(cheatSheet(mac, true).flatMap((s) => s.rows.flatMap((r) => r.keys)));
      for (const p of presses) {
        const label = comboLabel(
          {
            key: p.key,
            ...(p.mod && { mod: true }),
            ...(p.alt && { alt: true }),
            ...(p.shift && { shift: true }),
          },
          mac,
        );
        // The platform's other modifier is never a shortcut, so never listed.
        const inSheet = !p.otherMod && listed.has(label);
        expect({ press: p, label, handled: handled(p) }).toEqual({
          press: p,
          label,
          handled: inSheet,
        });
      }
    });
  }

  it('gives every key combo to one shortcut only', () => {
    const labels = SHORTCUTS.flatMap((s) => s.combos.map((c) => comboLabel(c, true)));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('writes keys the platform’s way', () => {
    const trash = SHORTCUTS.find((s) => s.id === 'trash')!.combos[0]!;
    expect(comboLabel(trash, true)).toBe('⌘⌫');
    expect(comboLabel(trash, false)).toBe('Ctrl+Backspace');
    expect(comboLabel({ key: 'ArrowDown', alt: true, shift: true, mod: true }, true)).toBe('⌥⇧⌘↓');
    expect(comboLabel({ key: 'ArrowDown', alt: true, shift: true, mod: true }, false)).toBe(
      'Ctrl+Alt+Shift+↓',
    );
  });

  it('leaves recenter off the standalone window’s sheet', () => {
    const ids = (docked: boolean) =>
      cheatSheet(true, docked).flatMap((s) => s.rows.map((r) => r.id));
    expect(ids(true)).toContain('recenter');
    expect(ids(false)).not.toContain('recenter');
  });
});

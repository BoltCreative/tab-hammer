/**
 * The view's keyboard shortcuts, in one table: the key handlers (`navIntent`, `viewShortcut`, App's
 * Escape) only act on a key press `shortcutOf` finds here, and the Keyboard shortcuts sheet and the
 * tooltips are rendered from it, so the two can't drift apart.
 */

/**
 * A key press, reduced to what the view's keys care about. `mod` is the platform's command key
 * (⌘ on a Mac, Ctrl elsewhere); `otherMod` is the one that isn't (Ctrl on a Mac, the Windows key
 * elsewhere), which no shortcut uses.
 */
export interface KeyPress {
  key: string;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  otherMod: boolean;
}

export function keyPressOf(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>,
  mac: boolean,
): KeyPress {
  return {
    key: e.key,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: mac ? e.metaKey : e.ctrlKey,
    otherMod: mac ? e.ctrlKey : e.metaKey,
  };
}

/** One key with its modifiers, matched exactly (an unlisted modifier held means no match). */
export interface Combo {
  key: string;
  mod?: true;
  alt?: true;
  shift?: true;
}

export type ShortcutId =
  | 'move'
  | 'select'
  | 'open'
  | 'up'
  | 'moveWindow'
  | 'activate'
  | 'trash'
  | 'escape'
  | 'currentTabs'
  | 'recenter'
  | 'shortcuts';

export interface Shortcut {
  id: ShortcutId;
  section: 'Outline' | 'View';
  combos: readonly Combo[];
  /** What it does, for the sheet. */
  does: string;
  /** A short name, for the search box's tooltip. */
  short: string;
}

const up: Combo = { key: 'ArrowUp' };
const down: Combo = { key: 'ArrowDown' };

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'move', section: 'Outline', combos: [up, down], does: 'Move the cursor', short: 'move' },
  {
    id: 'select',
    section: 'Outline',
    combos: [
      { ...up, shift: true },
      { ...down, shift: true },
    ],
    does: 'Extend the selection',
    short: 'select',
  },
  {
    id: 'open',
    section: 'Outline',
    combos: [{ ...down, mod: true }],
    does: 'Open: expand a row, step into it, or go to a tab',
    short: 'open',
  },
  {
    id: 'up',
    section: 'Outline',
    combos: [{ ...up, mod: true }],
    does: 'Collapse a row, or go up a level',
    short: 'up a level',
  },
  {
    id: 'moveWindow',
    section: 'Outline',
    combos: [
      { ...up, alt: true },
      { ...down, alt: true },
    ],
    does: 'Move the window up or down the list',
    short: 'move window',
  },
  {
    id: 'activate',
    section: 'Outline',
    combos: [{ key: 'Enter' }],
    does: 'Go to the tab or window (reopen a closed one)',
    short: 'open',
  },
  {
    id: 'trash',
    section: 'Outline',
    combos: [{ key: 'Backspace', mod: true }],
    does: 'Move the selection to the trash',
    short: 'move to trash',
  },
  {
    id: 'escape',
    section: 'Outline',
    combos: [{ key: 'Escape' }],
    does: 'Clear the search, then the selection',
    short: 'clear',
  },
  {
    id: 'currentTabs',
    section: 'View',
    combos: [{ key: '/', mod: true }],
    does: "Current tabs: just each window's active tab",
    short: 'current tabs',
  },
  {
    id: 'recenter',
    section: 'View',
    combos: [{ key: '\\', mod: true }],
    does: "Go to the current window's tab",
    short: 'go to the current window',
  },
  {
    id: 'shortcuts',
    section: 'View',
    combos: [{ key: "'", mod: true }],
    does: 'Show these keyboard shortcuts',
    short: 'shortcuts',
  },
];

const matches = (c: Combo, p: KeyPress) =>
  c.key === p.key && !!c.mod === p.mod && !!c.alt === p.alt && !!c.shift === p.shift;

/** The shortcut a key press is, or null. */
export function shortcutOf(p: KeyPress): ShortcutId | null {
  if (p.otherMod) return null;
  return SHORTCUTS.find((s) => s.combos.some((c) => matches(c, p)))?.id ?? null;
}

export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUTS.find((s) => s.id === id)!;
}

const KEY_NAMES: Record<string, { mac: string; other: string }> = {
  ArrowUp: { mac: '↑', other: '↑' },
  ArrowDown: { mac: '↓', other: '↓' },
  Backspace: { mac: '⌫', other: 'Backspace' },
  Escape: { mac: 'Esc', other: 'Esc' },
  Enter: { mac: 'Enter', other: 'Enter' },
};

/** A combo as the platform writes it: ⌥⇧⌘↓ on a Mac, Ctrl+Alt+Shift+↓ elsewhere. */
export function comboLabel(c: Combo, mac: boolean): string {
  const name = KEY_NAMES[c.key]?.[mac ? 'mac' : 'other'] ?? c.key.toUpperCase();
  if (mac) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${name}`;
  return `${c.mod ? 'Ctrl+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${name}`;
}

/** A shortcut's keys for a tooltip: "⌘/", "↑/↓". */
export function keysLabel(id: ShortcutId, mac: boolean): string {
  return shortcut(id)
    .combos.map((c) => comboLabel(c, mac))
    .join(' / ');
}

export interface SheetSection {
  title: string;
  rows: { id: ShortcutId; keys: string[]; does: string }[];
}

/** The Keyboard shortcuts sheet's sections, in the table's order. */
export function cheatSheet(mac: boolean): SheetSection[] {
  const sections: SheetSection[] = [];
  for (const s of SHORTCUTS) {
    let section = sections.find((x) => x.title === s.section);
    if (!section) sections.push((section = { title: s.section, rows: [] }));
    section.rows.push({ id: s.id, keys: s.combos.map((c) => comboLabel(c, mac)), does: s.does });
  }
  return sections;
}

/** The search box's tooltip: typing, then the outline's keys. */
export function searchKeysHelp(mac: boolean): string {
  return [
    'Type to search',
    ...SHORTCUTS.filter((s) => s.section === 'Outline').map(
      (s) => `${keysLabel(s.id, mac)} ${s.short}`,
    ),
  ].join(' · ');
}

/** A Mac (⌘ is the command key) or not (Ctrl is). */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The command key's name in help text. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';

/** The search box's tooltip: the outline's keys. */
export const SEARCH_KEYS_HELP = [
  'Type to search',
  '↑/↓ move',
  '⇧↑/↓ select',
  `${MOD_KEY}↓ open`,
  `${MOD_KEY}↑ up a level`,
  `${IS_MAC ? '⌥' : 'Alt+'}↑/↓ move window`,
  `${MOD_KEY}${IS_MAC ? '⌫' : 'Backspace'} move to trash`,
  'Enter open',
  'Esc clear',
].join(' · ');

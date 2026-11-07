import { keysLabel, searchKeysHelp } from '../model/shortcuts';

/** A Mac (⌘ is the command key) or not (Ctrl is). */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The search box's tooltip: the outline's keys. */
export const SEARCH_KEYS_HELP = searchKeysHelp(IS_MAC);

/** The Current tabs toggle's shortcut, for its tooltip. */
export const CURRENT_TABS_KEYS = keysLabel('currentTabs', IS_MAC);

/** The recenter button's shortcut, for its tooltip. */
export const RECENTER_KEYS = keysLabel('recenter', IS_MAC);

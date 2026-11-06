// The bridge protocol between Tab Hammer's service worker and its MCP server.
//
// Path of a call: Claude → MCP server (stdio) → native host (Unix socket, one JSON object per line)
// → service worker (Chrome native messaging) and back. The native host only relays: it rewrites
// `id` so calls from several MCP servers can share one Chrome connection, and nothing else. Both
// ends compile against this file, so a method or field rename breaks the build, not a live call.
//
// Node runs this file directly (type stripping), so keep it to erasable TypeScript: no enums,
// namespaces, or parameter properties.

/** Native messaging host name. Chrome finds the host by a manifest file with this name. */
export const NATIVE_HOST_NAME = 'com.boltcreative.tab_hammer';

/** Tab Hammer's extension ID, pinned by the manifest `key` (local and dev builds). */
export const EXTENSION_ID = 'lpnkidobhhpmokecbinbliomjehmndia';

/**
 * The Chrome Web Store listing's extension ID, which the store assigns (it ignores the manifest
 * `key`). The installer allows it alongside EXTENSION_ID; `npx tab-hammer-mcp install
 * --extension-id <id>` allows another ID.
 */
export const STORE_EXTENSION_ID: string = 'dcgapifimbojbcgenneeiaoobaabgnib';

export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export const GROUP_COLORS: readonly GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

export interface TabInfo {
  tabId: number;
  title: string;
  url: string;
  active: boolean; // the selected tab in its window
  pinned: boolean;
  discarded: boolean; // unloaded from memory by Chrome
  lastAccessed?: string; // ISO time the user last viewed it
}

export interface GroupInfo {
  groupId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabs: TabInfo[];
}

export interface WindowInfo {
  windowId: number;
  focused: boolean; // the window the user was last in (Tab Hammer's own window never counts)
  incognito: boolean;
  // Tabs and groups in tab-strip order. A group appears once per contiguous run of its tabs.
  items: (TabInfo | GroupInfo)[];
}

/** Every bridge method: its params and its result. */
export interface Methods {
  list_tabs: { params: Record<string, never>; result: { windows: WindowInfo[] } };
  focus_tab: { params: { tabId: number }; result: null };
  open_tabs: {
    params: { urls: string[]; windowId?: number }; // no windowId → a new window
    result: { windowId: number; tabIds: number[] };
  };
  move_tabs: {
    params: { tabIds: number[]; windowId?: number; index?: number }; // no windowId → new window
    result: { windowId: number };
  };
  group_tabs: {
    params: { tabIds: number[]; groupId?: number; title?: string; color?: GroupColor };
    result: { groupId: number };
  };
  ungroup_tabs: { params: { tabIds: number[] }; result: null };
  update_group: {
    params: { groupId: number; title?: string; color?: GroupColor; collapsed?: boolean };
    result: null;
  };
  close_tabs: { params: { tabIds: number[] }; result: { closed: number } };
}

export type Method = keyof Methods;

export type BridgeRequest<M extends Method = Method> = M extends Method
  ? { id: number; method: M; params: Methods[M]['params'] }
  : never;

export type BridgeResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

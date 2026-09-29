export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface RawWindow {
  id: number;
}

export interface RawTab {
  id: number;
  windowId: number;
  index: number;
  groupId: number; // -1 = ungrouped
  title?: string;
  url?: string;
  pendingUrl?: string;
  active: boolean;
  discarded: boolean;
  lastAccessed?: number; // ms since epoch
}

export interface RawGroup {
  id: number;
  windowId: number;
  title?: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface RawSnapshot {
  windows: RawWindow[];
  tabs: RawTab[];
  groups: RawGroup[];
  selfWindowId: number | null; // Tab Hammer's own window, excluded from the tree
  // The most recently focused window other than Tab Hammer's own (null if unknown).
  lastFocusedWindowId: number | null;
}

export interface TabNode {
  kind: 'tab';
  key: string; // `t:${tabId}`
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  discarded: boolean;
  lastAccessed?: number; // ms since epoch, when the user last viewed the tab
}

export interface GroupNode {
  kind: 'group';
  // `g:${groupId}` for a group's first run in its window; later split runs of the same group
  // get `g:${groupId}#${n}` (n = 2, 3, …). Stable while the group's tabs close or move.
  key: string;
  groupId: number;
  title: string;
  color: GroupColor;
  chromeCollapsed: boolean;
  tabs: TabNode[];
}

export interface WindowNode {
  kind: 'window';
  key: string; // `w:${windowId}`
  windowId: number;
  label: string;
  focused: boolean; // the last-focused window other than Tab Hammer
  tabCount: number;
  children: (GroupNode | TabNode)[];
}

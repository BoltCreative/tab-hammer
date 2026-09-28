export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface RawWindow {
  id: number;
  focused: boolean;
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
}

export interface GroupNode {
  kind: 'group';
  key: string; // `g:${groupId}:${firstTabId}`, unique even for split runs
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
  focused: boolean;
  tabCount: number;
  children: (GroupNode | TabNode)[];
}

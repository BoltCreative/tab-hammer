// The view model: the worker's outline (src/shared/outlineMessages.ts) as the rows the view
// renders. Keys are Tab Hammer record IDs; Chrome IDs are present only while the row is live.

export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface TabNode {
  kind: 'tab';
  key: string; // `t:${id}`
  id: string; // TabRec.id
  tabId?: number; // Chrome IDs, live only
  windowId?: number;
  title: string;
  url: string;
  active: boolean;
  discarded: boolean;
  lastAccessed?: number; // ms since epoch, when the user last viewed the tab
  hibernated: boolean; // no live Chrome tab
}

export interface GroupNode {
  kind: 'group';
  // `g:${id}` for a group's first run in its window; later split runs of the same group get
  // `g:${id}#${n}` (n = 2, 3, …). Stable while the group's tabs close or move.
  key: string;
  id: string; // GroupRec.id
  chromeGroupId?: number; // live only
  title: string;
  color: GroupColor;
  chromeCollapsed: boolean; // GroupRec.collapsed (Chrome's flag while live)
  hibernated: boolean; // no live tabs
  tabs: TabNode[];
}

export interface WindowNode {
  kind: 'window';
  key: string; // `w:${id}`
  id: string; // WindowRec.id
  windowId?: number; // Chrome's, live only
  label: string;
  name?: string;
  focused: boolean; // the last-focused normal window
  hibernated: boolean; // state !== 'live'
  closedAt?: number; // trash entries
  tabCount: number;
  children: (GroupNode | TabNode)[];
}

export interface OutlineView {
  windows: WindowNode[];
  trash: WindowNode[]; // newest first
}

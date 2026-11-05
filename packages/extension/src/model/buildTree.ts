import type { GroupRec, TabRec, WindowRec } from './outline/types';
import type { LiveDetails, OutlineState } from '../shared/outlineMessages';
import type { GroupNode, OutlineView, TabNode, WindowNode } from './types';

function toTabNode(t: TabRec, w: WindowRec, live: LiveDetails): TabNode {
  const details = t.chromeTabId === undefined ? undefined : live.tabs[t.chromeTabId];
  return {
    kind: 'tab',
    key: `t:${t.id}`,
    id: t.id,
    tabId: t.chromeTabId,
    windowId: t.chromeTabId === undefined ? undefined : w.chromeWindowId,
    title: t.title || t.url,
    url: t.url,
    active: details?.active ?? false,
    discarded: details?.discarded ?? false,
    lastAccessed: details?.lastAccessed,
    hibernated: t.chromeTabId === undefined,
  };
}

function toWindowNode(w: WindowRec, label: string, live: LiveDetails): WindowNode {
  const groups = new Map<string, GroupRec>(w.groups.map((g) => [g.id, g]));
  const children: (GroupNode | TabNode)[] = [];
  let run: GroupNode | null = null;
  const runsPerGroup = new Map<string, number>();
  for (const t of w.tabs) {
    const node = toTabNode(t, w, live);
    const g = t.groupId === undefined ? undefined : groups.get(t.groupId);
    if (!g) {
      run = null;
      children.push(node);
      continue;
    }
    if (!run || run.id !== g.id) {
      const n = (runsPerGroup.get(g.id) ?? 0) + 1;
      runsPerGroup.set(g.id, n);
      run = {
        kind: 'group',
        key: n === 1 ? `g:${g.id}` : `g:${g.id}#${n}`,
        id: g.id,
        chromeGroupId: g.chromeGroupId,
        title: g.title || 'Untitled group',
        color: g.color,
        chromeCollapsed: g.collapsed,
        hibernated: true,
        tabs: [],
      };
      children.push(run);
    }
    run.tabs.push(node);
    if (!node.hibernated) run.hibernated = false;
  }
  const hibernated = w.state !== 'live';
  return {
    kind: 'window',
    key: `w:${w.id}`,
    id: w.id,
    windowId: hibernated ? undefined : w.chromeWindowId,
    label,
    name: w.name,
    focused: !hibernated && w.chromeWindowId === live.focusedWindowId,
    hibernated,
    closedAt: w.closedAt,
    tabCount: w.tabs.length,
    children,
  };
}

/**
 * The worker's outline as view rows: `windows` in outline order (trashed ones left out), labelled
 * by name or position; `trash`, the trashed windows newest first, labelled by name or first tab.
 */
export function buildTree(state: OutlineState): OutlineView {
  const { live } = state;
  const open = state.windows.filter((w) => w.state !== 'trashed');
  const trashed = state.windows
    .filter((w) => w.state === 'trashed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  return {
    windows: open.map((w, i) => toWindowNode(w, w.name ?? `Window ${i + 1}`, live)),
    trash: trashed.map((w) => {
      const first = w.tabs[0];
      return toWindowNode(w, w.name ?? (first ? first.title || first.url : 'Empty window'), live);
    }),
  };
}

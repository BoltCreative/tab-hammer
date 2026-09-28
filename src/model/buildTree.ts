import type { GroupNode, RawGroup, RawSnapshot, RawTab, TabNode, WindowNode } from './types';

function toTabNode(t: RawTab): TabNode {
  const url = t.url || t.pendingUrl || '';
  return {
    kind: 'tab',
    key: `t:${t.id}`,
    tabId: t.id,
    windowId: t.windowId,
    title: t.title || url,
    url,
    active: t.active,
    discarded: t.discarded,
  };
}

export function buildTree(snapshot: RawSnapshot): WindowNode[] {
  const groups = new Map<number, RawGroup>(snapshot.groups.map((g) => [g.id, g]));
  const tabsByWindow = new Map<number, RawTab[]>();
  for (const t of snapshot.tabs) {
    const list = tabsByWindow.get(t.windowId) ?? [];
    list.push(t);
    tabsByWindow.set(t.windowId, list);
  }

  return snapshot.windows
    .filter((w) => w.id !== snapshot.selfWindowId)
    .map((w, i) => {
      const tabs = (tabsByWindow.get(w.id) ?? []).slice().sort((a, b) => a.index - b.index);
      const children: (GroupNode | TabNode)[] = [];
      let run: GroupNode | null = null;
      const runsPerGroup = new Map<number, number>();
      for (const t of tabs) {
        const g = t.groupId === -1 ? undefined : groups.get(t.groupId);
        if (!g) {
          run = null;
          children.push(toTabNode(t));
          continue;
        }
        if (!run || run.groupId !== g.id) {
          const n = (runsPerGroup.get(g.id) ?? 0) + 1;
          runsPerGroup.set(g.id, n);
          run = {
            kind: 'group',
            key: n === 1 ? `g:${g.id}` : `g:${g.id}#${n}`,
            groupId: g.id,
            title: g.title || 'Untitled group',
            color: g.color,
            chromeCollapsed: g.collapsed,
            tabs: [],
          };
          children.push(run);
        }
        run.tabs.push(toTabNode(t));
      }
      return {
        kind: 'window',
        key: `w:${w.id}`,
        windowId: w.id,
        label: `Window ${i + 1}`,
        focused: w.id === snapshot.lastFocusedWindowId,
        tabCount: tabs.length,
        children,
      };
    });
}

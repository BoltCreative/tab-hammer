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
      for (const t of tabs) {
        const g = t.groupId === -1 ? undefined : groups.get(t.groupId);
        if (!g) {
          run = null;
          children.push(toTabNode(t));
          continue;
        }
        if (!run || run.groupId !== g.id) {
          run = {
            kind: 'group',
            key: `g:${g.id}:${t.id}`,
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
        focused: w.focused,
        tabCount: tabs.length,
        children,
      };
    });
}

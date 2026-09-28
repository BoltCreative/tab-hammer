import { useCallback, useEffect, useMemo, useReducer, useState, type MouseEvent } from 'react';
import { buildTree } from '../model/buildTree';
import { emptySelection, selectionReducer } from '../model/selection';
import type { RawSnapshot, TabNode } from '../model/types';
import {
  allRowKeys,
  isGroupCollapsed,
  visibleRowKeys,
  type CollapseState,
} from '../model/visibleRows';
import { activateTab, focusWindow, snapshot, subscribe } from './chrome/chromeSource';
import { selectionActionFor } from './components/rowClick';
import { WindowCard } from './components/WindowCard';

export function App() {
  const [snap, setSnap] = useState<RawSnapshot | null>(null);
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [collapse, setCollapse] = useState<CollapseState>({
    collapsedWindows: new Set(),
    groupOverrides: new Map(),
  });

  const refresh = useCallback(() => {
    void snapshot().then(setSnap);
  }, []);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  const tree = useMemo(() => (snap ? buildTree(snap) : []), [snap]);
  const visible = useMemo(() => visibleRowKeys(tree, collapse), [tree, collapse]);

  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(tree) });
  }, [tree]);

  const onSelect = (e: MouseEvent, key: string) => dispatch(selectionActionFor(e, key, visible));
  const onActivate = (t: TabNode) => void activateTab(t.tabId, t.windowId).catch(refresh);
  const onFocusWindow = (id: number) => void focusWindow(id).catch(refresh);

  const onToggleWindow = (key: string) =>
    setCollapse((c) => {
      const next = new Set(c.collapsedWindows);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...c, collapsedWindows: next };
    });

  const onToggleGroup = useCallback(
    (key: string) =>
      setCollapse((c) => {
        const group = tree.flatMap((w) => w.children).find((x) => x.key === key);
        if (!group || group.kind !== 'group') return c;
        const next = new Map(c.groupOverrides);
        next.set(key, !isGroupCollapsed(group, c));
        return { ...c, groupOverrides: next };
      }),
    [tree],
  );

  return (
    <main>
      {tree.map((w) => (
        <WindowCard
          key={w.key}
          win={w}
          collapse={collapse}
          selected={selection.selected}
          onToggleWindow={onToggleWindow}
          onToggleGroup={onToggleGroup}
          onSelect={onSelect}
          onActivate={onActivate}
          onFocusWindow={onFocusWindow}
        />
      ))}
    </main>
  );
}

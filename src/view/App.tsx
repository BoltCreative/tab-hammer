import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { buildTree } from '../model/buildTree';
import { emptySelection, selectionReducer } from '../model/selection';
import type { TabNode, WindowNode } from '../model/types';
import {
  allRowKeys,
  discardStaleOverrides,
  toggleGroup,
  visibleRowKeys,
  type CollapseState,
} from '../model/visibleRows';
import { activateTab, focusWindow, snapshot, subscribe } from './chrome/chromeSource';
import { selectionActionFor } from './components/rowClick';
import { WindowCard } from './components/WindowCard';

export function App() {
  const [tree, setTree] = useState<WindowNode[]>([]);
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [collapse, setCollapse] = useState<CollapseState>({
    collapsedWindows: new Set(),
    groupOverrides: new Map(),
  });

  // Snapshots can resolve out of order; only the most recently requested one may land.
  const latestRequest = useRef(0);
  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    snapshot()
      .then((s) => {
        if (request !== latestRequest.current) return;
        const next = buildTree(s);
        setTree(next);
        setCollapse((c) => discardStaleOverrides(next, c));
      })
      .catch((err: unknown) => console.error('Tab Hammer: reading Chrome state failed', err));
  }, []);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

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
        return toggleGroup(group, c);
      }),
    [tree],
  );

  return (
    <main role="tree" aria-multiselectable="true">
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

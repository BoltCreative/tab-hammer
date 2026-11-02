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
import { ContextMenu } from './components/ContextMenu';
import { selectionActionFor } from './components/rowClick';
import { WindowCard } from './components/WindowCard';
import { HoverCard } from './hover/HoverCard';
import { hoverSignature } from './hover/hoverSignature';
import { useHoverCard } from './hover/useHoverCard';
import { AppHeader } from './header/AppHeader';

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
  const signatureOf = useCallback(
    (key: string) => hoverSignature(tree, visible, key),
    [tree, visible],
  );
  // Only the outline list scrolls; the header above it stays fixed.
  const listRef = useRef<HTMLElement>(null);
  const [hovered, hover] = useHoverCard(signatureOf, listRef);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const hoveredTab = useMemo(
    () =>
      hovered &&
      tree
        .flatMap((w) => w.children.flatMap((c) => (c.kind === 'group' ? c.tabs : [c])))
        .find((t) => t.key === hovered.key),
    [tree, hovered],
  );

  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(tree) });
  }, [tree]);

  const onSelect = (e: MouseEvent, key: string) => dispatch(selectionActionFor(e, key, visible));
  const onActivate = (t: TabNode) => void activateTab(t.tabId, t.windowId).catch(refresh);
  const onFocusWindow = (id: number) => void focusWindow(id).catch(refresh);

  // Right-click menu on a window header. Holds the window's key, not the node, so the menu always
  // acts on the window's current tabs even if they change while it is open.
  const [menu, setMenu] = useState<{ x: number; y: number; windowKey: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onWindowContextMenu = (e: MouseEvent, win: WindowNode) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, windowKey: win.key });
  };
  const menuWindow = menu && tree.find((w) => w.key === menu.windowKey);
  // The window's URLs in tab order, one per line (blank ones, e.g. a tab still loading, skipped).
  const copyWindowUrls = (win: WindowNode) => {
    const urls = win.children
      .flatMap((c) => (c.kind === 'group' ? c.tabs : [c]))
      .map((t) => t.url)
      .filter(Boolean);
    navigator.clipboard
      .writeText(urls.join('\n'))
      .catch((err: unknown) => console.error('Tab Hammer: copying URLs failed', err));
  };

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
    <div className="app">
      <AppHeader onPreviewsCleared={() => setPreviewEpoch((n) => n + 1)} />
      <main ref={listRef} className="outline" role="tree" aria-multiselectable="true">
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
            onWindowContextMenu={onWindowContextMenu}
            hover={hover}
          />
        ))}
      </main>
      {hovered && hoveredTab && (
        <HoverCard tab={hoveredTab} row={hovered.row} list={listRef} previewEpoch={previewEpoch} />
      )}
      {menu && menuWindow && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            {
              label: `Copy all URLs (${menuWindow.tabCount})`,
              onSelect: () => copyWindowUrls(menuWindow),
            },
          ]}
        />
      )}
    </div>
  );
}

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
import { countTabs, filterTree } from '../model/filterTree';
import {
  EXPAND_ALL,
  allRowKeys,
  discardStaleOverrides,
  toggleGroup,
  visibleRowKeys,
  type CollapseState,
} from '../model/visibleRows';
import { planMove } from '../model/moveSelection';
import { activateTab, applyMoveOps, focusWindow, snapshot, subscribe } from './chrome/chromeSource';
import { ContextMenu } from './components/ContextMenu';
import { selectionActionFor } from './components/rowClick';
import { useRowDrag } from './components/useRowDrag';
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

  // The search box narrows what the outline shows (`shown`), expanded so every match is visible.
  // Moves still plan against the whole tree.
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = shown !== tree;
  const shownCollapse = filtering ? EXPAND_ALL : collapse;
  const visible = useMemo(() => visibleRowKeys(shown, shownCollapse), [shown, shownCollapse]);
  const signatureOf = useCallback(
    (key: string) => hoverSignature(shown, visible, key),
    [shown, visible],
  );
  // Only the outline list scrolls; the header above it stays fixed.
  const listRef = useRef<HTMLElement>(null);
  const [hovered, hover] = useHoverCard(signatureOf, listRef);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  // Previews were cleared or refreshed: an open hover card looks its preview up again.
  const bumpPreviewEpoch = useCallback(() => setPreviewEpoch((n) => n + 1), []);
  const hoveredTab = useMemo(
    () =>
      hovered &&
      shown
        .flatMap((w) => w.children.flatMap((c) => (c.kind === 'group' ? c.tabs : [c])))
        .find((t) => t.key === hovered.key),
    [shown, hovered],
  );

  // Rows a search hides leave the selection, so a drag never carries rows the user can't see.
  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(shown) });
  }, [shown]);

  const onSelect = (e: MouseEvent, key: string) => dispatch(selectionActionFor(e, key, visible));
  const drag = useRowDrag(
    selection.selected,
    (key) => dispatch({ type: 'click', key }),
    (keys, target) => {
      const ops = planMove(tree, keys, target);
      if (ops.length === 0) return;
      applyMoveOps(ops).catch((err: unknown) => {
        console.error('Tab Hammer: moving tabs failed', err);
        refresh();
      });
    },
  );
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
      <AppHeader
        onPreviewsChanged={bumpPreviewEpoch}
        query={query}
        onQueryChange={setQuery}
        matchCount={filtering ? countTabs(shown) : null}
      />
      <main ref={listRef} className="outline" role="tree" aria-multiselectable="true">
        {filtering && shown.length === 0 && <p className="outline-empty">No matching tabs</p>}
        {shown.map((w) => (
          <WindowCard
            key={w.key}
            win={w}
            collapse={shownCollapse}
            selected={selection.selected}
            onToggleWindow={onToggleWindow}
            onToggleGroup={onToggleGroup}
            onSelect={onSelect}
            onActivate={onActivate}
            onFocusWindow={onFocusWindow}
            onWindowContextMenu={onWindowContextMenu}
            hover={hover}
            drag={drag}
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

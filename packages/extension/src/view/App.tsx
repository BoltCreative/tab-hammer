import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { emptySelection, selectionReducer } from '../model/selection';
import type { GroupNode, OutlineView, TabNode, WindowNode } from '../model/types';
import { findDuplicates } from '../model/duplicates';
import { countTabs, filterTree } from '../model/filterTree';
import { navIntent, outlineRows } from '../model/keyboardNav';
import {
  EXPAND_ALL,
  allRowKeys,
  discardStaleOverrides,
  toggleGroup,
  type CollapseState,
} from '../model/visibleRows';
import { planDrop } from '../model/moveSelection';
import { activateTab, applyMoveOps, closeTabs, focusWindow } from './chrome/chromeSource';
import { sendOutlineCommand, useOutline } from './chrome/outlineClient';
import type { OutlineCommand } from '../shared/outlineMessages';
import { ContextMenu } from './components/ContextMenu';
import { selectionActionFor } from './components/rowClick';
import type { RowCommands, RowPropsFor } from './components/rowProps';
import { useRowDrag } from './components/useRowDrag';
import { RecentlyClosed } from './components/RecentlyClosed';
import { WindowCard } from './components/WindowCard';
import { HoverCard } from './hover/HoverCard';
import { hoverSignature } from './hover/hoverSignature';
import { useHoverCard } from './hover/useHoverCard';
import { AppHeader } from './header/AppHeader';

export function App() {
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [collapse, setCollapse] = useState<CollapseState>({
    collapsedWindows: new Set(),
    groupOverrides: new Map(),
  });
  // The worker's outline, re-rendered on every broadcast. Moves and other Chrome actions show up
  // through it, so nothing here re-reads Chrome after acting.
  const { windows: tree, trash } = useOutline(
    useCallback((v: OutlineView) => setCollapse((c) => discardStaleOverrides(v.windows, c)), []),
  );

  // The search box narrows what the outline shows (`shown`), expanded so every match is visible.
  // Moves still plan against the whole tree.
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  // Duplicates are found across the whole tree, whatever the search shows.
  const duplicates = useMemo(() => findDuplicates(tree), [tree]);
  const filtering = shown !== tree;
  const shownCollapse = filtering ? EXPAND_ALL : collapse;
  const rows = useMemo(() => outlineRows(shown, shownCollapse), [shown, shownCollapse]);
  const visible = useMemo(() => rows.map((r) => r.key), [rows]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
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

  // The keyboard cursor: the row arrow keys move from. A click puts it on the clicked row.
  const [cursor, setCursor] = useState<string | null>(null);
  // The one row in the Tab order (roving tabindex): the cursor, or the first row.
  const tabStop = cursor !== null && rowByKey.has(cursor) ? cursor : (visible[0] ?? null);
  const focusRow = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();

  const onSelect = (e: MouseEvent, key: string) => {
    setCursor(key);
    dispatch(selectionActionFor(e, key, visible));
  };
  const drag = useRowDrag(
    selection.selected,
    (key) => dispatch({ type: 'click', key }),
    (keys, target) => {
      const { chrome, place } = planDrop(tree, keys, target);
      // Chrome first: the worker reconciles with Chrome before placing, so the live tabs are
      // already where the placement expects them.
      void (async () => {
        await applyMoveOps(chrome);
        if (place) await sendOutlineCommand({ cmd: 'place', placement: place });
      })().catch((err: unknown) => console.error('Tab Hammer: moving tabs failed', err));
    },
  );
  const rowProps: RowPropsFor = (key, kind) => {
    const r = rowByKey.get(key);
    return {
      ...drag(key, kind),
      tabIndex: key === tabStop ? 0 : -1,
      'aria-level': r?.level,
      'aria-setsize': r?.setSize,
      'aria-posinset': r?.posInSet,
      'aria-expanded': r?.expanded,
    };
  };
  const send = (c: OutlineCommand) => sendOutlineCommand(c).catch(logCommandError);
  const commands: RowCommands = {
    hibernate: (id) => send({ cmd: 'hibernate', ids: [id] }),
    trash: (id) => send({ cmd: 'trash', ids: [id] }),
    open: (id) => send({ cmd: 'open', id }),
    deleteForever: (windowId) => send({ cmd: 'deleteForever', windowId }),
  };
  // Enter or double-click. A hibernated row opens; a live tab is activated, a live window focused.
  const onActivate = (t: TabNode) => {
    if (t.hibernated) commands.open(t.id);
    else if (t.tabId !== undefined && t.windowId !== undefined) {
      activateTab(t.tabId, t.windowId).catch(logActionError);
    }
  };
  // A window holding any hibernated rows opens them (into it, when it's live).
  const onFocusWindow = (w: WindowNode) => {
    if (w.hibernated || hasHibernatedRows(w)) commands.open(w.id);
    else if (w.windowId !== undefined) focusWindow(w.windowId).catch(logActionError);
  };
  // Delete/Backspace: the selected rows, or the cursor row when nothing is selected.
  const trashRows = (cursorKey: string) => {
    const keys = selection.selected.size > 0 ? [...selection.selected] : [cursorKey];
    const ids = keys.flatMap((k) => findNode(tree, k)?.id ?? []);
    if (ids.length > 0) send({ cmd: 'trash', ids });
  };

  // The window whose label is an inline rename field, if any.
  const [renaming, setRenaming] = useState<string | null>(null);
  const onEndRename = (w: WindowNode, name: string | null) => {
    setRenaming(null);
    if (name !== null && name.trim() !== (w.name ?? '')) {
      send({ cmd: 'rename', windowId: w.id, name });
    }
    // Enter or Escape: keyboard focus goes back to the row. Leaving the field by clicking elsewhere
    // has already moved focus, so it stays where the click put it.
    if (document.activeElement?.classList.contains('rename-field')) focusRow(w.key);
  };

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

  const onTreeKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const intent = navIntent(rows, tabStop, e.key, e.shiftKey);
    if (!intent) return;
    e.preventDefault();
    switch (intent.type) {
      case 'move':
        setCursor(intent.key);
        dispatch(
          intent.extend
            ? { type: 'range', key: intent.key, visible }
            : { type: 'click', key: intent.key },
        );
        focusRow(intent.key);
        break;
      case 'toggleSelect':
        dispatch({ type: 'toggle', key: intent.key });
        break;
      case 'toggleExpand':
        if (intent.key.startsWith('w:')) onToggleWindow(intent.key);
        else onToggleGroup(intent.key);
        break;
      case 'activate': {
        // Same as double-click: a tab is activated, a window focused, a hibernated row opened; a
        // live group expands or collapses.
        const node = findNode(shown, intent.key);
        if (node?.kind === 'tab') onActivate(node);
        else if (node?.kind === 'window') onFocusWindow(node);
        else if (node?.kind === 'group' && node.hibernated) commands.open(node.id);
        else if (node?.kind === 'group' && rowByKey.get(node.key)?.expanded !== undefined) {
          onToggleGroup(node.key);
        }
        break;
      }
      case 'trash':
        trashRows(intent.key);
        break;
    }
  };
  // Down arrow in the search box moves into the outline.
  const enterOutline = () => {
    if (tabStop === null) return;
    setCursor(tabStop);
    focusRow(tabStop);
  };

  return (
    <div className="app">
      <AppHeader
        onPreviewsChanged={bumpPreviewEpoch}
        query={query}
        onQueryChange={setQuery}
        onSearchArrowDown={enterOutline}
        duplicateCount={duplicates.toClose.length}
        onCloseDuplicates={() => closeTabs(duplicates.toClose.flatMap((t) => t.tabId ?? []))}
        matchCount={filtering ? countTabs(shown) : null}
      />
      <main
        ref={listRef}
        className="outline"
        role="tree"
        aria-label="Windows and tabs"
        aria-multiselectable="true"
        onKeyDown={onTreeKeyDown}
      >
        {filtering && shown.length === 0 && <p className="outline-empty">No matching tabs</p>}
        {shown.map((w) => (
          <WindowCard
            key={w.key}
            win={w}
            collapse={shownCollapse}
            selected={selection.selected}
            duplicates={duplicates.keys}
            onToggleWindow={onToggleWindow}
            onToggleGroup={onToggleGroup}
            onSelect={onSelect}
            onActivate={onActivate}
            onFocusWindow={onFocusWindow}
            onWindowContextMenu={onWindowContextMenu}
            hover={hover}
            rowProps={rowProps}
            commands={commands}
            renaming={renaming === w.key}
            onStartRename={setRenaming}
            onEndRename={onEndRename}
          />
        ))}
        {/* Search doesn't cover the trash, so it hides while a query is active. */}
        {!filtering && (
          <RecentlyClosed
            entries={trash}
            restore={commands.open}
            deleteForever={commands.deleteForever}
          />
        )}
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

function logActionError(err: unknown) {
  console.error('Tab Hammer: Chrome action failed', err);
}

function logCommandError(err: unknown) {
  console.error('Tab Hammer: outline command failed', err);
}

function hasHibernatedRows(w: WindowNode): boolean {
  return w.children.some((c) => (c.kind === 'group' ? c.tabs : [c]).some((t) => t.hibernated));
}

function findNode(tree: WindowNode[], key: string): WindowNode | GroupNode | TabNode | undefined {
  for (const w of tree) {
    if (w.key === key) return w;
    for (const c of w.children) {
      if (c.key === key) return c;
      if (c.kind === 'group') {
        const t = c.tabs.find((x) => x.key === key);
        if (t) return t;
      }
    }
  }
  return undefined;
}

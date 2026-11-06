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
import { draggedTabIds, planDrop } from '../model/moveSelection';
import { activateTab, applyMoveOps, closeTabs, focusWindow } from './chrome/chromeSource';
import { dockInto, useHostWindowId } from './chrome/dock';
import { sendOutlineCommand, useOutline } from './chrome/outlineClient';
import type { OutlineCommand } from '../shared/outlineMessages';
import { ContextMenu } from './components/ContextMenu';
import { selectionActionFor } from './components/rowClick';
import type { RowCommands, RowPropsFor } from './components/rowProps';
import { useRowDrag } from './components/useRowDrag';
import { RecentlyClosed } from './components/RecentlyClosed';
import { WindowCard } from './components/WindowCard';
import { PreviewPanel } from './preview/PreviewPanel';
import { usePreviewTarget } from './preview/usePreviewTarget';
import { AppHeader } from './header/AppHeader';
import { useHeaderActions } from './header/useHeaderActions';
import type { SyncSource } from '../shared/syncMessages';
import { DevicesPanel } from './sync/DevicePicker';
import { useRemoteOutline } from './sync/RemoteOutline';
import { useSyncState } from './sync/syncClient';

export function App() {
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  // Another device's outline (or a checkpoint) shown read-only in place of this computer's.
  const syncState = useSyncState();
  const [remoteSource, setRemoteSource] = useState<SyncSource | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const closeDevices = useCallback(() => setDevicesOpen(false), []);
  const remote = useRemoteOutline({
    source: remoteSource,
    state: syncState,
    onBack: useCallback(() => setRemoteSource(null), []),
  });
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
  const filtering = shown !== tree;
  // A docked panel marks the browser window it sits in, and opens scrolled to it.
  const hostWindowId = useHostWindowId();
  // Duplicates are found across the whole tree, whatever the search shows.
  const duplicates = useMemo(() => findDuplicates(tree), [tree]);
  const shownCollapse = filtering ? EXPAND_ALL : collapse;
  const rows = useMemo(() => outlineRows(shown, shownCollapse), [shown, shownCollapse]);
  const visible = useMemo(() => rows.map((r) => r.key), [rows]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  // Only the outline list scrolls; the header above it stays fixed.
  const listRef = useRef<HTMLElement>(null);

  // Once, when a docked panel opens: scroll its own window's card to the top of the list.
  const scrolledToHost = useRef(false);
  useEffect(() => {
    if (scrolledToHost.current || hostWindowId === undefined) return;
    const list = listRef.current;
    const card = list
      ?.querySelector(`[data-kind="window"][data-window-id="${hostWindowId}"]`)
      ?.closest('section');
    if (!list || !card) return; // not in the outline yet; try again on the next broadcast
    scrolledToHost.current = true;
    // Set directly: scrollIntoView would honor the list's scroll-padding (room for keyboard focus
    // under a pinned bar) and stop short. The list's bottom padding lets even the last window
    // reach the top.
    list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, [hostWindowId, tree]);

  // Rows a search hides leave the selection, so a drag never carries rows the user can't see.
  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(shown) });
  }, [shown]);

  // The keyboard cursor: the row arrow keys move from. A click puts it on the clicked row.
  const [cursor, setCursor] = useState<string | null>(null);
  // The one row in the Tab order (roving tabindex): the cursor, or the first row.
  const tabStop = cursor !== null && rowByKey.has(cursor) ? cursor : (visible[0] ?? null);

  // The preview panel shows the tab hovered or moved to last, kept while nothing is hovered.
  const { key: previewKey, hover, show: showPreview } = usePreviewTarget();
  const moveCursor = (key: string) => {
    setCursor(key);
    if (key.startsWith('t:')) showPreview(key);
  };
  const previewTab = useMemo(() => {
    const node = previewKey === null ? undefined : findNode(tree, previewKey);
    return node?.kind === 'tab' ? node : undefined;
  }, [tree, previewKey]);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  // Previews were cleared or refreshed: the panel looks its tab's preview up again.
  const bumpPreviewEpoch = useCallback(() => setPreviewEpoch((n) => n + 1), []);
  const focusRow = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();

  const onSelect = (e: MouseEvent, key: string) => {
    moveCursor(key);
    dispatch(selectionActionFor(e, key, visible));
  };
  const recordId = (key: string) => findNode(tree, key)?.id;
  const drag = useRowDrag(selection.selected, {
    onSelectOnly: (key) => dispatch({ type: 'click', key }),
    onMove: (keys, target) => {
      const { chrome, place } = planDrop(tree, keys, target);
      // Chrome first: the worker reconciles with Chrome before placing, so the live tabs are
      // already where the placement expects them.
      void (async () => {
        await applyMoveOps(chrome);
        if (place) await sendOutlineCommand({ cmd: 'place', placement: place });
      })().catch((err: unknown) => console.error('Tab Hammer: moving tabs failed', err));
    },
    onReorder: (windowKeys, anchorKey, side) => {
      const anchorId = recordId(anchorKey);
      const ids = windowKeys.flatMap((k) => recordId(k) ?? []);
      if (anchorId !== undefined && ids.length > 0) {
        send({ cmd: 'moveWindows', ids, anchorId, side });
      }
    },
    onNewWindow: (keys) => {
      const tabIds = draggedTabIds(tree, keys);
      if (tabIds.length > 0) sendOpening({ cmd: 'moveToNewWindow', tabIds, afterWindowId: null });
    },
  });
  const rowProps: RowPropsFor = (key, kind) => {
    const r = rowByKey.get(key);
    return {
      ...drag.row(key, kind),
      tabIndex: key === tabStop ? 0 : -1,
      'aria-level': r?.level,
      'aria-setsize': r?.setSize,
      'aria-posinset': r?.posInSet,
      'aria-expanded': r?.expanded,
    };
  };
  // The window being used: docked, the one this panel sits in; else Chrome's focused window.
  const currentWindow = () =>
    (hostWindowId === undefined ? undefined : tree.find((w) => w.windowId === hostWindowId)) ??
    tree.find((w) => w.focused);
  const send = (c: OutlineCommand) => sendOutlineCommand(c).catch(logCommandError);
  // A command that opens a Chrome window: docked, the panel follows into it.
  const sendOpening = (c: OutlineCommand) =>
    sendOutlineCommand(c).then(dockInto).catch(logCommandError);
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
  // acts on the window's current tabs even if they change while it is open. A null key is the
  // outline background's menu: the header's Actions.
  const [menu, setMenu] = useState<{ x: number; y: number; windowKey: string | null } | null>(null);
  // Right-click menu on tab and group rows: the rows it acts on (the selection, if the click was
  // on a selected row).
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onWindowContextMenu = (e: MouseEvent, win: WindowNode) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, windowKey: win.key });
  };
  // Anywhere in the list that isn't a row (or a field) offers the header's Actions. Rows keep the
  // browser's menu unless they have their own (window headers do).
  const onBackgroundContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, button')) return;
    const row = target.closest<HTMLElement>('.row[data-kind="tab"], .row[data-kind="group"]');
    if (row?.dataset.key) {
      const key = row.dataset.key;
      e.preventDefault();
      if (!selection.selected.has(key)) {
        dispatch({ type: 'click', key });
        moveCursor(key);
      }
      const keys = selection.selected.has(key) ? [...selection.selected] : [key];
      setRowMenu({ x: e.clientX, y: e.clientY, keys });
      return;
    }
    if (target.closest('.row')) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, windowKey: null });
  };
  const actions = useHeaderActions({
    onPreviewsChanged: bumpPreviewEpoch,
    duplicateCount: duplicates.toClose.length,
    onCloseDuplicates: () => closeTabs(duplicates.toClose.flatMap((t) => t.tabId ?? [])),
    onOpenDevices: () => setDevicesOpen(true),
    onNewWindow: () =>
      sendOpening({ cmd: 'newWindow', afterWindowId: currentWindow()?.id ?? null }),
  });
  const menuWindow =
    menu?.windowKey != null ? tree.find((w) => w.key === menu.windowKey) : undefined;
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

  // Alt+Up / Alt+Down: moves the window holding the cursor (or the selected windows) one place.
  const stepWindows = (key: string, delta: -1 | 1) => {
    const selectedWindows = shown.filter((w) => selection.selected.has(w.key));
    const cursorWindow = shown.find((w) => w.key === key || findNode([w], key) !== undefined);
    const moving =
      selectedWindows.length > 0 ? selectedWindows : cursorWindow ? [cursorWindow] : [];
    if (moving.length === 0) return;
    // The neighbour past the block, among the windows shown.
    const at = delta < 0 ? shown.indexOf(moving[0]!) : shown.indexOf(moving[moving.length - 1]!);
    const neighbour = shown[at + delta];
    if (!neighbour || moving.includes(neighbour)) return;
    send({
      cmd: 'moveWindows',
      ids: moving.map((w) => w.id),
      anchorId: neighbour.id,
      side: delta < 0 ? 'before' : 'after',
    });
  };

  const onTreeKeyDown = (e: KeyboardEvent) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (tabStop !== null) stepWindows(tabStop, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const intent = navIntent(rows, tabStop, e.key, e.shiftKey);
    if (!intent) return;
    e.preventDefault();
    switch (intent.type) {
      case 'move':
        moveCursor(intent.key);
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
    moveCursor(tabStop);
    focusRow(tabStop);
  };

  return (
    <div className="app">
      <AppHeader
        actions={actions}
        query={query}
        onQueryChange={setQuery}
        onSearchArrowDown={enterOutline}
        matchCount={filtering ? countTabs(shown) : null}
        banner={
          <>
            {devicesOpen && (
              <DevicesPanel
                state={syncState}
                current={remoteSource}
                onPick={setRemoteSource}
                onClose={closeDevices}
              />
            )}
            {remote.banner}
          </>
        }
      />
      {remote.list}
      <main
        ref={listRef}
        className="outline"
        hidden={remote.list !== null}
        onContextMenu={onBackgroundContextMenu}
      >
        <div
          className="outline-tree"
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
              cardProps={drag.card(w.key)}
              commands={commands}
              here={hostWindowId !== undefined && w.windowId === hostWindowId}
              renaming={renaming === w.key}
              onStartRename={setRenaming}
              onEndRename={onEndRename}
            />
          ))}
        </div>
        {/* Beside the tree, not in it: its keys and ARIA roles are not the outline's. Search
            doesn't cover the trash, so it hides while a query is active. */}
        {!filtering && (
          <RecentlyClosed
            entries={trash}
            restore={commands.open}
            deleteForever={commands.deleteForever}
          />
        )}
      </main>
      {/* Its own strip between the list and the preview panel, so it never covers a row. */}
      {drag.newWindow && (
        <div className="new-window-drop" data-testid="new-window-drop" {...drag.newWindow}>
          Drop here for a new window
        </div>
      )}
      <PreviewPanel tab={previewTab} previewEpoch={previewEpoch} />
      {menu && menu.windowKey === null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          label="Actions"
          items={actions.items}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={closeRowMenu}
          items={[
            {
              label: (() => {
                const n = draggedTabIds(tree, rowMenu.keys).length;
                return `Open in new window (${n} ${n === 1 ? 'tab' : 'tabs'})`;
              })(),
              title: 'Move these tabs into a new window, listed right after the one they came from',
              onSelect: () => {
                const tabIds = draggedTabIds(tree, rowMenu.keys);
                const from = tree.find((w) =>
                  w.children.some((c) => tabsIn(c).some((t) => t.id === tabIds[0])),
                );
                if (tabIds.length > 0) {
                  sendOpening({ cmd: 'moveToNewWindow', tabIds, afterWindowId: from?.id ?? null });
                }
              },
            },
          ]}
        />
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

function tabsIn(c: GroupNode | TabNode): TabNode[] {
  return c.kind === 'group' ? c.tabs : [c];
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

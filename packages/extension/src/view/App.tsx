import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { emptySelection, selectionReducer } from '../model/selection';
import type { GroupNode, OutlineView, TabNode, WindowNode } from '../model/types';
import { findDuplicates } from '../model/duplicates';
import { countTabs, filterTree, queryTerms } from '../model/filterTree';
import { currentTabsNavRows, currentTabsTree, recenterTarget } from '../model/currentTabs';
import {
  TRASH_SECTION_KEY,
  keyPressOf,
  navIntent,
  outlineRows,
  trashRows,
  typesIntoSearch,
  viewShortcut,
} from '../model/keyboardNav';
import {
  EXPAND_ALL,
  allRowKeys,
  discardStaleOverrides,
  toggleGroup,
  type CollapseState,
} from '../model/visibleRows';
import { draggedTabIds, planDrop } from '../model/moveSelection';
import { activateTab, applyMoveOps, closeTabs, focusWindow } from './chrome/chromeSource';
import { useCurrentTabsSetting } from './chrome/currentTabsSetting';
import { dockInto, useHostWindowId } from './chrome/dock';
import { sendOutlineCommand, useOutline } from './chrome/outlineClient';
import type { OutlineCommand } from '../shared/outlineMessages';
import { ContextMenu } from './components/ContextMenu';
import { selectionActionFor } from './components/rowClick';
import {
  OUTLINE_TREE_ID,
  rowDomId,
  type RowCommands,
  type RowPropsFor,
} from './components/rowProps';
import { useRowDrag } from './components/useRowDrag';
import { RecentlyClosed } from './components/RecentlyClosed';
import { WindowCard } from './components/WindowCard';
import { PreviewPanel } from './preview/PreviewPanel';
import { usePreviewTarget } from './preview/usePreviewTarget';
import { AppHeader } from './header/AppHeader';
import { IS_MAC } from './platform';
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
  const filtering = queryTerms(query).length > 0;
  // Current tabs: each window shows just its active tab (a view filter, remembered and shared by
  // every view). A search overrides it while the query is non-empty.
  const [currentTabs, setCurrentTabs] = useCurrentTabsSetting();
  const currentView = currentTabs && !filtering;
  const shown = useMemo(
    () => (filtering ? filterTree(tree, query) : currentView ? currentTabsTree(tree) : tree),
    [tree, query, filtering, currentView],
  );
  // A docked panel marks the browser window it sits in, and opens scrolled to it.
  const hostWindowId = useHostWindowId();
  // Duplicates are found across the whole tree, whatever the search shows.
  const duplicates = useMemo(() => findDuplicates(tree), [tree]);
  const shownCollapse = filtering || currentView ? EXPAND_ALL : collapse;
  const rows = useMemo(() => outlineRows(shown, shownCollapse), [shown, shownCollapse]);
  const rowAria = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  // What can be selected: the outline's rows.
  const visible = useMemo(() => rows.map((r) => r.key), [rows]);
  // Recently closed: whether the section is open and which of its windows show their tabs.
  const [trashOpen, setTrashOpen] = useState(false);
  // Turning Current tabs on (here or in another view) folds Recently closed away.
  const [prevCurrentTabs, setPrevCurrentTabs] = useState(currentTabs);
  if (prevCurrentTabs !== currentTabs) {
    setPrevCurrentTabs(currentTabs);
    if (currentTabs) setTrashOpen(false);
  }
  const [trashExpanded, setTrashExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleTrashEntry = (key: string) =>
    setTrashExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // What the cursor moves through: the outline's rows (in Current tabs, the tabs stand for their
  // windows), then Recently closed's (hidden while searching, since search doesn't cover the trash).
  const navRows = useMemo(() => {
    const outline = currentView ? currentTabsNavRows(rows) : rows;
    return filtering ? outline : [...outline, ...trashRows(trash, trashOpen, trashExpanded)];
  }, [filtering, currentView, rows, trash, trashOpen, trashExpanded]);
  const rowByKey = useMemo(() => new Map(navRows.map((r) => [r.key, r])), [navRows]);
  // Only the outline list scrolls; the header above it stays fixed.
  const listRef = useRef<HTMLElement>(null);

  // Rows a search hides leave the selection, so a drag never carries rows the user can't see.
  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(shown) });
  }, [shown]);

  // The keyboard cursor: the highlighted row ↑/↓ move from, while focus stays in the search box
  // (which names it with aria-activedescendant). A click puts it on the clicked row. While
  // searching with no cursor, it's the first match, as in a command palette.
  const [cursor, setCursor] = useState<string | null>(null);
  const activeKey =
    cursor !== null && rowByKey.has(cursor) ? cursor : filtering ? (navRows[0]?.key ?? null) : null;
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = () => {
    const search = searchRef.current;
    if (!search || document.activeElement === search) return;
    search.focus({ preventScroll: true });
    // Typing that lands here goes after what's already there.
    search.setSelectionRange(search.value.length, search.value.length);
  };
  // Keep the cursor row in view as it moves (and when a search starts or ends around it).
  useEffect(() => {
    if (activeKey === null) return;
    document.getElementById(rowDomId(activeKey))?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, filtering]);

  // The preview panel shows the tab hovered or moved to last, kept while nothing is hovered.
  const { key: previewKey, hover, show: showPreview } = usePreviewTarget();
  const moveCursor = (key: string) => {
    setCursor(key);
    if (key.startsWith('t:')) showPreview(key);
  };
  const previewTab = useMemo(() => {
    // A tab of the outline, or of a window in Recently closed.
    const node =
      previewKey === null ? undefined : (findNode(tree, previewKey) ?? findNode(trash, previewKey));
    return node?.kind === 'tab' ? node : undefined;
  }, [tree, trash, previewKey]);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  // Previews were cleared or refreshed: the panel looks its tab's preview up again.
  const bumpPreviewEpoch = useCallback(() => setPreviewEpoch((n) => n + 1), []);

  const onSelect = (e: MouseEvent, key: string) => {
    moveCursor(key);
    dispatch(selectionActionFor(e, key, visible));
    // Focus lives in the search box, so the next key typed or pressed goes there.
    focusSearch();
    // In Current tabs, a plain click on a tab goes to it: its window comes forward on that tab.
    if (currentView && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const node = findNode(shown, key);
      if (node?.kind === 'tab') onActivate(node);
    }
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
    const r = rowAria.get(key);
    return {
      ...drag.row(key, kind),
      id: rowDomId(key),
      'data-cursor': key === activeKey || undefined,
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
  // ⌘⌫ (Ctrl+Backspace off a Mac): the selected rows, or the cursor row when nothing is selected.
  const trashSelection = (cursorKey: string) => {
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
    // Enter or Escape: keyboard focus goes back to the search box, the cursor on the window.
    // Leaving the field by clicking elsewhere has already moved focus, so it stays where the click
    // put it.
    if (document.activeElement?.classList.contains('rename-field')) {
      setCursor(w.key);
      focusSearch();
    }
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

  // ⌥↑ / ⌥↓: moves the window holding the cursor (or the selected windows) one place.
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

  // Enter on a Recently closed row: the section toggles, a closed window reopens.
  const activateTrashRow = (key: string) => {
    if (key === TRASH_SECTION_KEY) setTrashOpen((o) => !o);
    else {
      const w = trash.find((x) => x.key === key);
      if (w) commands.open(w.id);
    }
  };
  const toggleExpand = (key: string) => {
    if (key === TRASH_SECTION_KEY) setTrashOpen((o) => !o);
    else if (rowByKey.get(key)?.trash) toggleTrashEntry(key);
    else if (key.startsWith('w:')) onToggleWindow(key);
    else onToggleGroup(key);
  };

  // Recenter: the current window's active tab (its header, with none) goes to the middle of the
  // list, its window and group expanded, with the cursor on it, so Enter acts on it right away.
  // Leaves any search, since it's about the whole outline. State only, so a docked panel's first
  // render can do it too.
  const [centerOn, setCenterOn] = useState<{ key: string; n: number } | null>(null);
  const planRecenter = (win: WindowNode) => {
    const target = recenterTarget(win, collapse);
    if (target.expandWindow || target.expandGroup) {
      setCollapse((c) => {
        let next = c;
        if (target.expandWindow) {
          const windows = new Set(next.collapsedWindows);
          windows.delete(win.key);
          next = { ...next, collapsedWindows: windows };
        }
        return target.expandGroup ? toggleGroup(target.expandGroup, next) : next;
      });
    }
    if (query !== '') setQuery('');
    setCursor(target.key);
    setCenterOn((c) => ({ key: target.key, n: (c?.n ?? 0) + 1 }));
    return target.key;
  };
  const recenter = (win: WindowNode | undefined = currentWindow()) => {
    if (!win) return;
    const key = planRecenter(win);
    if (key.startsWith('t:')) showPreview(key);
    focusSearch();
  };
  // Once, when a docked panel opens: recenter on the browser window it sits in, as soon as both
  // that window and the outline are known.
  const [centeredOnHost, setCenteredOnHost] = useState(false);
  if (!centeredOnHost && hostWindowId !== undefined) {
    const host = tree.find((w) => w.windowId === hostWindowId);
    if (host) {
      setCenteredOnHost(true);
      planRecenter(host);
    }
  }
  // After the render that shows the target row: center it in the list (clear of the sticky window
  // bar above and the preview panel below, which sits outside the list). Declared after the
  // cursor's scroll-into-view, so it runs last.
  const centered = useRef(0);
  useEffect(() => {
    const list = listRef.current;
    if (!centerOn || centered.current === centerOn.n || !list) return;
    const row = document.getElementById(rowDomId(centerOn.key));
    if (!row) return; // not rendered yet; try again on the next outline
    centered.current = centerOn.n;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // Set directly: scrollIntoView would honour the list's scroll-padding. The list's bottom
    // padding leaves room to center even the last rows.
    list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
  }, [centerOn, rows]);

  // The view's keys, command-palette style (`navIntent`): focus lives in the search box, typing
  // anywhere goes there, and only ↑/↓-based keys, modifier combos, Enter and Escape drive the
  // outline. One listener on the document, so they work wherever focus is in this page (each
  // docked panel is its own page with its own). Text fields other than search (rename), open
  // menus and the devices panel keep their own keys; React handlers that consume a key (the
  // preview panel's resize edge) prevent its default, which this skips.
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || remote.list !== null) return;
    if (document.querySelector('[role="menu"]')) return;
    const target = e.target instanceof Element ? e.target : document.body;
    const search = searchRef.current;
    const inSearch = target === search;
    if (!inSearch && target.closest('input, textarea, select, [contenteditable]')) return;
    if (target.closest('[data-own-keys]')) return;
    // Away from the search box, a focused button keeps Enter and Space.
    const onControl = !inSearch && target !== document.body && target.closest('button, a[href]');
    if (onControl && (e.key === 'Enter' || e.key === ' ')) return;

    const press = keyPressOf(e, IS_MAC);
    const shortcut = viewShortcut(press);
    if (shortcut) {
      e.preventDefault();
      if (shortcut === 'currentTabs') setCurrentTabs(!currentTabs);
      else recenter();
      return;
    }
    if (e.key === 'Escape' && !press.mod && !press.alt && !press.shift) {
      // First clears the search (the cursor stays on its row, now among the whole outline), then
      // the selection.
      if (query !== '') {
        e.preventDefault();
        if (activeKey !== null) setCursor(activeKey);
        setQuery('');
      } else if (selection.selected.size > 0) {
        e.preventDefault();
        dispatch({ type: 'clear' });
      }
      return;
    }
    const intent = navIntent(navRows, activeKey, press);
    if (!intent) {
      const typing = typesIntoSearch({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altGraph: e.getModifierState('AltGraph'),
        isComposing: e.isComposing,
      });
      // Focused during keydown, the search box gets this key's character (or composition).
      if (typing && !inSearch) focusSearch();
      return;
    }
    e.preventDefault();
    focusSearch();
    const trashRow = rowByKey.get(intent.key)?.trash === true;
    switch (intent.type) {
      case 'move':
        moveCursor(intent.key);
        if (trashRow) dispatch({ type: 'clear' });
        else {
          dispatch(
            intent.extend
              ? { type: 'range', key: intent.key, visible }
              : { type: 'click', key: intent.key },
          );
        }
        break;
      case 'toggleExpand':
        toggleExpand(intent.key);
        break;
      case 'moveWindow':
        stepWindows(intent.key, intent.delta);
        break;
      case 'activate': {
        if (trashRow) {
          activateTrashRow(intent.key);
          break;
        }
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
        trashSelection(intent.key);
        break;
    }
  };
  const onKey = useEffectEvent(onDocumentKeyDown);
  useEffect(() => {
    const listener = (e: globalThis.KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
  // Typing a new search starts the cursor over, on the first match.
  const onQueryChange = (q: string) => {
    setQuery(q);
    setCursor(null);
  };

  return (
    <div className="app">
      <AppHeader
        actions={actions}
        query={query}
        onQueryChange={onQueryChange}
        searchRef={searchRef}
        activeDescendant={activeKey === null ? undefined : rowDomId(activeKey)}
        matchCount={filtering ? countTabs(shown) : null}
        currentTabs={currentTabs}
        onCurrentTabsChange={setCurrentTabs}
        onRecenter={() => recenter()}
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
          id={OUTLINE_TREE_ID}
          aria-label="Windows and tabs"
          aria-multiselectable="true"
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
        {/* Beside the tree, not in it: its rows are never selected and its ARIA roles are not the
            outline's, though the cursor runs on into it. Search doesn't cover the trash, so it
            hides while a query is active. */}
        {!filtering && (
          <RecentlyClosed
            entries={trash}
            open={trashOpen}
            onToggleOpen={() => setTrashOpen((o) => !o)}
            expanded={trashExpanded}
            onToggleEntry={toggleTrashEntry}
            cursor={activeKey}
            restore={commands.open}
            restoreAll={(ids) => send({ cmd: 'openAll', ids })}
            hover={hover}
            deleteForever={commands.deleteForever}
          />
        )}
      </main>
      {/* Over the preview panel, at the bottom of the window: appearing mid-drag, it must not move
          the rows under the pointer, and the preview panel is no drop target. */}
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

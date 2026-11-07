import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ContextMenu } from '../components/ContextMenu';
import { OUTLINE_TREE_ID, RECENTLY_CLOSED_ID } from '../components/rowProps';
import { dockEverywhere, popOut, surface, useSidePanelSide } from '../chrome/dock';
import { CURRENT_TABS_KEYS, RECENTER_KEYS, SEARCH_KEYS_HELP } from '../platform';
import { PreviewPermissionBanner } from '../permission/PreviewPermissionBanner';
import type { HeaderActions } from './useHeaderActions';

interface Props {
  actions: HeaderActions;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  activeDescendant: string | undefined; // the cursor row's DOM id
  matchCount: number | null; // tabs matching the search, or null when not searching
  banner?: ReactNode; // under the permission banner (another device's outline, say)
  currentTabs: boolean; // the Current tabs toggle
  onCurrentTabsChange: (on: boolean) => void;
  onRecenter?: () => void; // scroll to the current window's tab (docked panels only)
}

/**
 * The view's fixed header: it stays put while the outline scrolls beneath it. The search box,
 * the Actions menu (the same actions as a right-click on the outline's background), the live
 * status line with Stop while a Refresh runs, and the permission banner go here.
 */
export function AppHeader({
  actions,
  query,
  onQueryChange,
  searchRef,
  activeDescendant,
  matchCount,
  banner,
  currentTabs,
  onCurrentTabsChange,
  onRecenter,
}: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; keyboard: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Keeps the root's data-side current, so a docked panel's border faces the page.
  useSidePanelSide();
  const toggleMenu = (keyboard: boolean) => {
    if (menu) return setMenu(null);
    const r = button.current!.getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 2, keyboard });
  };

  return (
    <header className="app-header">
      <PreviewPermissionBanner />
      {banner}
      <div className="toolbar" role="toolbar" aria-label="Tab Hammer tools">
        {/* Where focus lives: a combobox whose highlighted option is the outline's cursor row.
            App's document key handler drives the outline from here (↑/↓, Enter, Escape…). */}
        <input
          ref={searchRef}
          type="search"
          role="combobox"
          className="search"
          placeholder="Search tabs"
          title={SEARCH_KEYS_HELP}
          aria-label="Search tabs by title or URL"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${OUTLINE_TREE_ID} ${RECENTLY_CLOSED_ID}`}
          aria-activedescendant={activeDescendant}
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {matchCount !== null && (
          <span className="toolbar-status" data-testid="match-count">
            {matchCount === 1 ? '1 tab' : `${matchCount} tabs`}
          </span>
        )}
        <button
          type="button"
          role="switch"
          className="current-tabs-switch"
          aria-checked={currentTabs}
          title={`Show just each window's current tab (${CURRENT_TABS_KEYS})`}
          onClick={() => onCurrentTabsChange(!currentTabs)}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          Current tabs
        </button>
        {onRecenter && (
          <button
            type="button"
            className="toolbar-button menu-button recenter-button"
            aria-label="Go to the current window"
            title={`Go to the current window's tab (${RECENTER_KEYS})`}
            onClick={onRecenter}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <path d="M6 0 V2 M6 10 V12 M0 6 H2 M10 6 H12" stroke="currentColor" />
            </svg>
          </button>
        )}
        <DockToggle />
        <button
          ref={button}
          type="button"
          className="toolbar-button menu-button"
          aria-label="Actions"
          title="Actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          // detail 0: Enter or Space, so the first item takes focus.
          onClick={(e) => toggleMenu(e.detail === 0)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="2" cy="6" r="1.2" fill="currentColor" />
            <circle cx="6" cy="6" r="1.2" fill="currentColor" />
            <circle cx="10" cy="6" r="1.2" fill="currentColor" />
          </svg>
        </button>
      </div>
      {/* Always in the DOM (a live region), shown only while there's something to say. */}
      <div className="toolbar-progress" hidden={!actions.status && !actions.stop}>
        <span className="toolbar-status" role="status">
          {actions.status}
        </span>
        {actions.stop && (
          <button
            type="button"
            className="toolbar-button"
            onClick={actions.stop}
            disabled={actions.stopping}
          >
            Stop
          </button>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={actions.items}
          onClose={closeMenu}
          label="Actions"
          anchor={button}
          autoFocus={menu.keyboard}
          align="right"
        />
      )}
    </header>
  );
}

/**
 * Float ⇄ dock. In the standalone window it docks the outline into Chrome's side panel in every
 * browser window (this click is what lets it open them) and closes the window; in a docked panel
 * it pops the outline back out to the standalone window and closes the panels.
 */
function DockToggle() {
  const docked = surface === 'panel';
  const label = docked ? 'Pop out to a window' : 'Dock in the side panel';
  const run = () =>
    void (docked ? popOut() : dockEverywhere()).catch((err: unknown) =>
      console.error('Tab Hammer: switching between window and side panel failed', err),
    );
  return (
    <button
      type="button"
      className="toolbar-button menu-button dock-toggle"
      aria-label={label}
      title={label}
      onClick={run}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="0.5" y="1.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" />
        {docked ? (
          // A window with an arrow leaving it: out of the panel.
          <path d="M4 8 L8 4 M5 4 H8 V7" fill="none" stroke="currentColor" />
        ) : (
          // A window with its right strip filled: the side panel.
          <rect x="7.5" y="2" width="3.5" height="8" fill="currentColor" />
        )}
      </svg>
    </button>
  );
}

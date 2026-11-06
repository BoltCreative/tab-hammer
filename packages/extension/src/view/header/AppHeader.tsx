import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '../components/ContextMenu';
import {
  dockEverywhere,
  openSidePanelSettings,
  popOut,
  surface,
  useSidePanelSide,
} from '../chrome/dock';
import { PreviewPermissionBanner } from '../permission/PreviewPermissionBanner';
import type { HeaderActions } from './useHeaderActions';

interface Props {
  actions: HeaderActions;
  query: string;
  onQueryChange: (query: string) => void;
  onSearchArrowDown: () => void;
  matchCount: number | null; // tabs matching the search, or null when not searching
  banner?: ReactNode; // under the permission banner (another device's outline, say)
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
  onSearchArrowDown,
  matchCount,
  banner,
}: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; keyboard: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const side = useSidePanelSide();
  const toggleMenu = (keyboard: boolean) => {
    if (menu) return setMenu(null);
    const r = button.current!.getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 2, keyboard });
  };

  return (
    <header className="app-header">
      <PreviewPermissionBanner />
      {side === 'left' && (
        <div className="permission-banner side-hint" role="note" data-testid="side-hint">
          <span>
            Side panel is on the left. Chrome&apos;s Appearance settings put it on the right.
          </span>
          <button type="button" onClick={openSidePanelSettings}>
            Settings
          </button>
        </div>
      )}
      {banner}
      <div className="toolbar" role="toolbar" aria-label="Tab Hammer tools">
        <input
          type="search"
          className="search"
          placeholder="Search tabs"
          aria-label="Search tabs by title or URL"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQueryChange('');
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              onSearchArrowDown();
            }
          }}
        />
        {matchCount !== null && (
          <span className="toolbar-status" data-testid="match-count">
            {matchCount === 1 ? '1 tab' : `${matchCount} tabs`}
          </span>
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

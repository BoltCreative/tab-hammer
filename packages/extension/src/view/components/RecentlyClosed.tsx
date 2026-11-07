import { useState, type KeyboardEvent } from 'react';
import type { TabNode, WindowNode } from '../../model/types';
import { faviconUrl } from '../chrome/favicon';
import type { HoverHandlers } from '../preview/usePreviewTarget';
import { RowToolbar, TrashIcon, RestoreIcon, type RowAction } from './RowToolbar';

interface Props {
  entries: WindowNode[]; // newest first
  restore: (id: string) => void; // opens the window in Chrome, its tabs as they were at close
  restoreAll: (ids: string[]) => void; // reopens every entry in Chrome, as restore does
  deleteForever: (id: string) => void;
  hover: HoverHandlers; // a tab row hovered: the preview panel shows it
  showPreview: (key: string) => void; // a tab row focused with the keyboard: shown at once
}

type TabProps = Pick<Props, 'hover' | 'showPreview'>;

/** Arrow keys move focus between a closed window's tab rows (they're not in the outline's Tab order). */
function moveFocus(e: KeyboardEvent<HTMLElement>, from: HTMLElement | null) {
  const next =
    e.key === 'ArrowDown'
      ? from?.nextElementSibling
      : e.key === 'ArrowUp'
        ? from?.previousElementSibling
        : undefined;
  if (next === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  if (next instanceof HTMLElement && next.classList.contains('trash-tab')) next.focus();
}

/**
 * The trash: closed windows, newest first, at the bottom of the outline. Plain rows, not outline
 * rows: no selection or drag, and only whole windows come back. A closed window's tabs preview in
 * the panel like the outline's, on hover or as the arrow keys move through them. Restore all, on
 * the section's own header, reopens every window, each with the tabs that were live at close.
 */
export function RecentlyClosed({
  entries,
  restore,
  restoreAll,
  deleteForever,
  hover,
  showPreview,
}: Props) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <section className="card trash" role="group" aria-label="Recently closed">
      <div className="trash-bar">
        <button
          type="button"
          className="row trash-header"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="twisty" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="title">Recently closed ({entries.length})</span>
        </button>
        <button
          type="button"
          className="trash-restore-all"
          title="Reopen every closed window, with the tabs that were open when it closed"
          onClick={() => restoreAll(entries.map((w) => w.id))}
        >
          Restore all
        </button>
      </div>
      {open && (
        <div role="list">
          {entries.map((w) => (
            <TrashEntry
              key={w.key}
              win={w}
              restore={restore}
              deleteForever={deleteForever}
              hover={hover}
              showPreview={showPreview}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TrashEntry({
  win,
  restore,
  deleteForever,
  hover,
  showPreview,
}: { win: WindowNode } & Pick<Props, 'restore' | 'deleteForever'> & TabProps) {
  const [expanded, setExpanded] = useState(false);
  const actions: RowAction[] = [
    { label: 'Restore', icon: RestoreIcon, onClick: () => restore(win.id) },
    { label: 'Delete forever', icon: TrashIcon, onClick: () => deleteForever(win.id) },
  ];
  const tabs = win.children.flatMap((c) => (c.kind === 'group' ? c.tabs : [c]));
  return (
    <div role="listitem">
      <div
        className="row window-header trash-entry"
        data-testid="trash-entry"
        onDoubleClick={() => restore(win.id)}
      >
        <button
          type="button"
          className="twisty"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Down from an expanded window's twisty goes into its tabs.
            if (e.key !== 'ArrowDown' || !expanded) return;
            moveFocus(e, e.currentTarget.closest<HTMLElement>('.trash-entry'));
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="title">{win.label}</span>
        <span className="count">
          {win.tabCount} {win.tabCount === 1 ? 'tab' : 'tabs'}
        </span>
        <RowToolbar actions={actions} />
      </div>
      {expanded &&
        tabs.map((t) => <TrashTab key={t.key} tab={t} hover={hover} showPreview={showPreview} />)}
    </div>
  );
}

function TrashTab({ tab, hover, showPreview }: { tab: TabNode } & TabProps) {
  return (
    <div
      className="row tab trash-tab"
      role="listitem"
      tabIndex={-1}
      onMouseEnter={() => hover.onRowEnter(tab.key)}
      onMouseLeave={hover.onRowLeave}
      onFocus={() => showPreview(tab.key)}
      onKeyDown={(e) => moveFocus(e, e.currentTarget)}
    >
      {tab.url ? (
        <img className="favicon" src={faviconUrl(tab.url)} alt="" />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title}</span>
    </div>
  );
}

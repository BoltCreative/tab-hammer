import type { TabNode, WindowNode } from '../../model/types';
import { TRASH_SECTION_KEY } from '../../model/keyboardNav';
import { faviconUrl } from '../chrome/favicon';
import type { HoverHandlers } from '../preview/usePreviewTarget';
import { RowToolbar, TrashIcon, RestoreIcon, type RowAction } from './RowToolbar';
import { RECENTLY_CLOSED_ID, rowDomId } from './rowProps';

interface Props {
  entries: WindowNode[]; // newest first
  open: boolean; // the section shows its closed windows
  onToggleOpen: () => void;
  expanded: ReadonlySet<string>; // closed windows showing their tabs
  onToggleEntry: (key: string) => void;
  cursor: string | null; // the outline's cursor, which runs on into these rows
  restore: (id: string) => void; // opens the window in Chrome, its tabs as they were at close
  restoreAll: (ids: string[]) => void; // reopens every entry in Chrome, as restore does
  deleteForever: (id: string) => void;
  hover: HoverHandlers; // a tab row hovered: the preview panel shows it
}

/** A row's id and cursor mark, as the outline's rows have them (see App's rowProps). */
const cursorProps = (key: string, cursor: string | null) => ({
  id: rowDomId(key),
  'data-cursor': key === cursor || undefined,
});

/**
 * The trash: closed windows, newest first, at the bottom of the outline. Plain rows, not outline
 * rows: no selection or drag, and only whole windows come back. The outline's cursor runs on
 * into them from its last row (App's `trashRows`), so ↑/↓ move through the section, ⌘↓/⌘↑ open and
 * close it and its windows, and Enter reopens a window. A closed window's tabs preview in the panel
 * like the outline's, on hover or under the cursor. Restore all, on the section's own header,
 * reopens every window, each with the tabs that were live at close.
 */
export function RecentlyClosed({
  entries,
  open,
  onToggleOpen,
  expanded,
  onToggleEntry,
  cursor,
  restore,
  restoreAll,
  deleteForever,
  hover,
}: Props) {
  if (entries.length === 0) return null;
  return (
    <section
      className="card trash"
      id={RECENTLY_CLOSED_ID}
      role="group"
      aria-label="Recently closed"
    >
      <div className="trash-bar">
        <button
          type="button"
          className="row trash-header"
          aria-expanded={open}
          onClick={onToggleOpen}
          {...cursorProps(TRASH_SECTION_KEY, cursor)}
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
              expanded={expanded.has(w.key)}
              onToggle={() => onToggleEntry(w.key)}
              cursor={cursor}
              restore={restore}
              deleteForever={deleteForever}
              hover={hover}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TrashEntry({
  win,
  expanded,
  onToggle,
  cursor,
  restore,
  deleteForever,
  hover,
}: {
  win: WindowNode;
  expanded: boolean;
  onToggle: () => void;
} & Pick<Props, 'cursor' | 'restore' | 'deleteForever' | 'hover'>) {
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
        {...cursorProps(win.key, cursor)}
      >
        <button
          type="button"
          className="twisty"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="title">{win.label}</span>
        <span className="count">
          {win.tabCount} {win.tabCount === 1 ? 'tab' : 'tabs'}
        </span>
        <RowToolbar actions={actions} />
      </div>
      {expanded && tabs.map((t) => <TrashTab key={t.key} tab={t} cursor={cursor} hover={hover} />)}
    </div>
  );
}

function TrashTab({ tab, cursor, hover }: { tab: TabNode } & Pick<Props, 'cursor' | 'hover'>) {
  return (
    <div
      className="row tab trash-tab"
      role="listitem"
      onMouseEnter={() => hover.onRowEnter(tab.key)}
      onMouseLeave={hover.onRowLeave}
      {...cursorProps(tab.key, cursor)}
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

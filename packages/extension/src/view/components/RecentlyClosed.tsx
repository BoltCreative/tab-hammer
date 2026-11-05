import { useState } from 'react';
import type { TabNode, WindowNode } from '../../model/types';
import { faviconUrl } from '../chrome/favicon';
import { RowToolbar, TrashIcon, RestoreIcon, type RowAction } from './RowToolbar';

interface Props {
  entries: WindowNode[]; // newest first
  restore: (id: string) => void;
  deleteForever: (id: string) => void;
}

/**
 * The trash: closed windows, newest first, at the bottom of the outline. Plain rows, not outline
 * rows: no selection, keyboard navigation, drag, or preview. Only whole windows come back.
 */
export function RecentlyClosed({ entries, restore, deleteForever }: Props) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <section className="card trash" role="group" aria-label="Recently closed">
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
      {open && (
        <div role="list">
          {entries.map((w) => (
            <TrashEntry key={w.key} win={w} restore={restore} deleteForever={deleteForever} />
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
}: { win: WindowNode } & Pick<Props, 'restore' | 'deleteForever'>) {
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
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="title">{win.label}</span>
        <span className="count">
          {win.tabCount} {win.tabCount === 1 ? 'tab' : 'tabs'}
        </span>
        <RowToolbar actions={actions} />
      </div>
      {expanded && tabs.map((t) => <TrashTab key={t.key} tab={t} />)}
    </div>
  );
}

function TrashTab({ tab }: { tab: TabNode }) {
  return (
    <div className="row tab trash-tab" role="listitem">
      {tab.url ? (
        <img className="favicon" src={faviconUrl(tab.url)} alt="" />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title}</span>
    </div>
  );
}

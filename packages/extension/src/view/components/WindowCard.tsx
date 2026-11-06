import type { CSSProperties, MouseEvent } from 'react';
import { windowColor } from '../../model/windowColor';
import type { TabNode, WindowNode } from '../../model/types';
import { isGroupCollapsed, type CollapseState } from '../../model/visibleRows';
import type { HoverHandlers } from '../preview/usePreviewTarget';
import { GroupRow } from './GroupRow';
import { TabRow } from './TabRow';
import { RenameField } from './RenameField';
import { EditIcon, HibernateIcon, RowToolbar, TrashIcon, type RowAction } from './RowToolbar';
import type { RowCommands, RowPropsFor } from './rowProps';

interface Props {
  win: WindowNode;
  collapse: CollapseState;
  selected: ReadonlySet<string>;
  duplicates: ReadonlySet<string>; // tab keys that share a URL with another tab
  onToggleWindow: (key: string) => void;
  onToggleGroup: (key: string) => void;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  onFocusWindow: (win: WindowNode) => void;
  onWindowContextMenu: (e: MouseEvent, win: WindowNode) => void;
  hover: HoverHandlers;
  rowProps: RowPropsFor;
  commands: RowCommands;
  here: boolean; // the browser window this docked panel sits in
  renaming: boolean; // the label is an inline text field
  onStartRename: (key: string) => void;
  onEndRename: (win: WindowNode, name: string | null) => void; // null: cancelled
}

export function WindowCard(p: Props) {
  const { win } = p;
  const collapsed = p.collapse.collapsedWindows.has(win.key);
  const actions: RowAction[] = [
    { label: 'Rename window', icon: EditIcon, onClick: () => p.onStartRename(win.key) },
    ...(win.hibernated
      ? []
      : [{ label: 'Hibernate', icon: HibernateIcon, onClick: () => p.commands.hibernate(win.id) }]),
    { label: 'Move to trash', icon: TrashIcon, onClick: () => p.commands.trash(win.id) },
  ];
  return (
    <section
      role="none"
      data-testid="window-card"
      className={['card', win.focused && 'focused', p.here && 'here'].filter(Boolean).join(' ')}
      style={{ '--window-color': `var(--group-${windowColor(win.id)})` } as CSSProperties}
    >
      <div
        className={win.hibernated ? 'row window-header hibernated' : 'row window-header'}
        role="treeitem"
        data-key={win.key}
        data-kind="window"
        data-window-id={win.windowId}
        {...(p.here && { 'aria-current': 'location' as const, title: 'This window' })}
        {...p.rowProps(win.key, 'window')}
        // While renaming, a drag in the field selects text instead of moving the window.
        {...(p.renaming && { draggable: false })}
        aria-selected={p.selected.has(win.key)}
        onClick={(e) => p.onSelect(e, win.key)}
        onDoubleClick={() => p.onFocusWindow(win)}
        onContextMenu={(e) => p.onWindowContextMenu(e, win)}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleWindow(win.key);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="window-glyph" aria-hidden="true" />
        {p.renaming ? (
          <RenameField
            initial={win.name ?? ''}
            placeholder={win.name === undefined ? win.label : undefined}
            onSave={(name) => p.onEndRename(win, name)}
            onCancel={() => p.onEndRename(win, null)}
          />
        ) : (
          <span className="title">{win.label}</span>
        )}
        <span className="count">
          {win.tabCount} {win.tabCount === 1 ? 'tab' : 'tabs'}
        </span>
        {!p.renaming && <RowToolbar actions={actions} />}
      </div>
      {!collapsed &&
        win.children.map((c) =>
          c.kind === 'group' ? (
            <GroupRow
              key={c.key}
              group={c}
              collapsed={isGroupCollapsed(c, p.collapse)}
              selected={p.selected}
              duplicates={p.duplicates}
              onToggleCollapse={p.onToggleGroup}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
              hover={p.hover}
              rowProps={p.rowProps}
              commands={p.commands}
            />
          ) : (
            <TabRow
              key={c.key}
              tab={c}
              selected={p.selected.has(c.key)}
              duplicate={p.duplicates.has(c.key)}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
              hover={p.hover}
              rowProps={p.rowProps}
              commands={p.commands}
            />
          ),
        )}
    </section>
  );
}

import type { CSSProperties, MouseEvent } from 'react';
import type { GroupNode, TabNode } from '../../model/types';
import type { HoverHandlers } from '../hover/useHoverCard';
import { TabRow } from './TabRow';
import type { RowPropsFor } from './rowProps';

interface Props {
  group: GroupNode;
  collapsed: boolean;
  selected: ReadonlySet<string>;
  duplicates: ReadonlySet<string>; // tab keys that share a URL with another tab
  onToggleCollapse: (key: string) => void;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  hover: HoverHandlers;
  rowProps: RowPropsFor;
}

export function GroupRow({
  group,
  collapsed,
  selected,
  duplicates,
  onToggleCollapse,
  onSelect,
  onActivate,
  hover,
  rowProps,
}: Props) {
  const style = { '--group-color': `var(--group-${group.color})` } as CSSProperties;
  return (
    <div role="none" style={style}>
      <div
        className="row group-header"
        role="treeitem"
        data-key={group.key}
        data-kind="group"
        {...rowProps(group.key, 'group')}
        aria-selected={selected.has(group.key)}
        onClick={(e) => onSelect(e, group.key)}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(group.key);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="group-dot" />
        <span className="title">{group.title}</span>
        <span className="count">{group.tabs.length}</span>
      </div>
      {!collapsed && (
        <div role="none" className="group-tabs">
          {group.tabs.map((t) => (
            <TabRow
              key={t.key}
              tab={t}
              selected={selected.has(t.key)}
              duplicate={duplicates.has(t.key)}
              onSelect={onSelect}
              onActivate={onActivate}
              hover={hover}
              rowProps={rowProps}
            />
          ))}
        </div>
      )}
    </div>
  );
}

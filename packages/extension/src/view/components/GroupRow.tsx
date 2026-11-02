import type { CSSProperties, MouseEvent } from 'react';
import type { GroupNode, TabNode } from '../../model/types';
import type { HoverHandlers } from '../hover/useHoverCard';
import { TabRow } from './TabRow';
import type { RowDrag } from './useRowDrag';

interface Props {
  group: GroupNode;
  collapsed: boolean;
  selected: ReadonlySet<string>;
  onToggleCollapse: (key: string) => void;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  hover: HoverHandlers;
  drag: RowDrag;
}

export function GroupRow({
  group,
  collapsed,
  selected,
  onToggleCollapse,
  onSelect,
  onActivate,
  hover,
  drag,
}: Props) {
  const style = { '--group-color': `var(--group-${group.color})` } as CSSProperties;
  return (
    <div style={style}>
      <div
        className="row group-header"
        role="treeitem"
        data-key={group.key}
        data-kind="group"
        {...drag(group.key, 'group')}
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
        <div className="group-tabs">
          {group.tabs.map((t) => (
            <TabRow
              key={t.key}
              tab={t}
              selected={selected.has(t.key)}
              onSelect={onSelect}
              onActivate={onActivate}
              hover={hover}
              drag={drag}
            />
          ))}
        </div>
      )}
    </div>
  );
}

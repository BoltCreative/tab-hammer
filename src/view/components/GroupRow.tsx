import type { CSSProperties, MouseEvent } from 'react';
import type { GroupNode, TabNode } from '../../model/types';
import { TabRow } from './TabRow';

interface Props {
  group: GroupNode;
  collapsed: boolean;
  selected: ReadonlySet<string>;
  onToggleCollapse: (key: string) => void;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
}

export function GroupRow({
  group,
  collapsed,
  selected,
  onToggleCollapse,
  onSelect,
  onActivate,
}: Props) {
  const style = { '--group-color': `var(--group-${group.color})` } as CSSProperties;
  return (
    <div style={style}>
      <div
        className="row group-header"
        data-key={group.key}
        data-kind="group"
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

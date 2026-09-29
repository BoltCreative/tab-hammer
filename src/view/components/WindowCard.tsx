import type { MouseEvent } from 'react';
import type { TabNode, WindowNode } from '../../model/types';
import { isGroupCollapsed, type CollapseState } from '../../model/visibleRows';
import { GroupRow } from './GroupRow';
import { TabRow } from './TabRow';

interface Props {
  win: WindowNode;
  collapse: CollapseState;
  selected: ReadonlySet<string>;
  onToggleWindow: (key: string) => void;
  onToggleGroup: (key: string) => void;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  onFocusWindow: (windowId: number) => void;
}

export function WindowCard(p: Props) {
  const { win } = p;
  const collapsed = p.collapse.collapsedWindows.has(win.key);
  return (
    <section data-testid="window-card" className={win.focused ? 'card focused' : 'card'}>
      <div
        className="row window-header"
        role="treeitem"
        data-key={win.key}
        data-kind="window"
        aria-selected={p.selected.has(win.key)}
        onClick={(e) => p.onSelect(e, win.key)}
        onDoubleClick={() => p.onFocusWindow(win.windowId)}
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
        <span className="title">{win.label}</span>
        <span className="count">{win.tabCount} tabs</span>
      </div>
      {!collapsed &&
        win.children.map((c) =>
          c.kind === 'group' ? (
            <GroupRow
              key={c.key}
              group={c}
              collapsed={isGroupCollapsed(c, p.collapse)}
              selected={p.selected}
              onToggleCollapse={p.onToggleGroup}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
            />
          ) : (
            <TabRow
              key={c.key}
              tab={c}
              selected={p.selected.has(c.key)}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
            />
          ),
        )}
    </section>
  );
}

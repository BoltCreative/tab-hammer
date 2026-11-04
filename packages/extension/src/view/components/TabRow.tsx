import { useState, type MouseEvent } from 'react';
import type { TabNode } from '../../model/types';
import { faviconUrl } from '../chrome/favicon';
import { HOVER_CARD_ID, type HoverHandlers } from '../hover/useHoverCard';
import { HibernateIcon, RowToolbar, TrashIcon, type RowAction } from './RowToolbar';
import type { RowCommands, RowPropsFor } from './rowProps';

interface Props {
  tab: TabNode;
  selected: boolean;
  duplicate: boolean; // another tab has the same URL
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  hover: HoverHandlers;
  rowProps: RowPropsFor;
  commands: RowCommands;
}

export function TabRow({
  tab,
  selected,
  duplicate,
  onSelect,
  onActivate,
  hover,
  rowProps,
  commands,
}: Props) {
  // Remember which URL's favicon failed, so a navigation to a new URL retries.
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconFailed = failedIconUrl === tab.url;
  const cls = [
    'row',
    'tab',
    tab.active && 'active',
    tab.discarded && 'discarded',
    duplicate && 'duplicate',
    tab.hibernated && 'hibernated',
  ]
    .filter(Boolean)
    .join(' ');
  const actions: RowAction[] = [
    ...(tab.hibernated
      ? []
      : [{ label: 'Hibernate', icon: HibernateIcon, onClick: () => commands.hibernate(tab.id) }]),
    { label: 'Move to trash', icon: TrashIcon, onClick: () => commands.trash(tab.id) },
  ];
  return (
    <div
      className={cls}
      role="treeitem"
      data-key={tab.key}
      data-kind="tab"
      data-tab-id={tab.tabId}
      {...rowProps(tab.key, 'tab')}
      aria-selected={selected}
      // The URL is no longer a native tooltip (the hover card replaced it), so name it here.
      aria-label={
        (tab.url && tab.url !== tab.title ? `${tab.title}, ${tab.url}` : tab.title) +
        (duplicate ? ', duplicate' : '')
      }
      aria-describedby={hover.openKey === tab.key ? HOVER_CARD_ID : undefined}
      onClick={(e) => onSelect(e, tab.key)}
      onDoubleClick={() => onActivate(tab)}
      onMouseEnter={(e) => hover.onRowEnter(tab.key, e.currentTarget)}
      onMouseLeave={hover.onRowLeave}
    >
      {tab.url && !iconFailed ? (
        <img
          className="favicon"
          src={faviconUrl(tab.url)}
          alt=""
          onError={() => setFailedIconUrl(tab.url)}
        />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title}</span>
      {duplicate && (
        <span className="dup-badge" aria-hidden="true">
          dup
        </span>
      )}
      <RowToolbar actions={actions} />
    </div>
  );
}

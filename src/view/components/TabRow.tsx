import { useState, type MouseEvent } from 'react';
import type { TabNode } from '../../model/types';
import { faviconUrl } from '../chrome/favicon';

interface Props {
  tab: TabNode;
  selected: boolean;
  onSelect: (e: MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
}

export function TabRow({ tab, selected, onSelect, onActivate }: Props) {
  const [iconFailed, setIconFailed] = useState(false);
  const cls = ['row', 'tab', tab.active && 'active', tab.discarded && 'discarded']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      data-key={tab.key}
      data-kind="tab"
      aria-selected={selected}
      title={tab.url}
      onClick={(e) => onSelect(e, tab.key)}
      onDoubleClick={() => onActivate(tab)}
    >
      {tab.url && !iconFailed ? (
        <img
          className="favicon"
          src={faviconUrl(tab.url)}
          alt=""
          onError={() => setIconFailed(true)}
        />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title}</span>
    </div>
  );
}

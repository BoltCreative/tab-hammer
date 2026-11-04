import type { HTMLAttributes } from 'react';

export type RowKind = 'window' | 'group' | 'tab';

/**
 * The attributes and handlers App gives each outline row: drag-and-drop (useRowDrag) plus the
 * ARIA tree attributes and roving tab stop for keyboard navigation.
 */
export type RowPropsFor = (
  key: string,
  kind: RowKind,
) => HTMLAttributes<HTMLDivElement> & { 'data-drop'?: string };

/** Outline commands a row's toolbar and double-click send to the worker, by record ID. */
export interface RowCommands {
  hibernate: (id: string) => void;
  trash: (id: string) => void;
  open: (id: string) => void;
  deleteForever: (windowId: string) => void;
}

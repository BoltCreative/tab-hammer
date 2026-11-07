import type { HTMLAttributes } from 'react';

export type RowKind = 'window' | 'group' | 'tab';

/**
 * The attributes and handlers App gives each outline row: drag-and-drop (useRowDrag), the ARIA
 * tree attributes, and the id and `data-cursor` mark the search box's aria-activedescendant uses.
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

/** A row's DOM id: what the search box's aria-activedescendant names for the cursor row. */
export const rowDomId = (key: string) => `row-${key}`;

/** The ids the search box names in aria-controls: the outline's tree and Recently closed. */
export const OUTLINE_TREE_ID = 'outline-tree';
export const RECENTLY_CLOSED_ID = 'recently-closed';

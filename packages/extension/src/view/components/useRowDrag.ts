import { useCallback, useRef, useState, type DragEvent } from 'react';
import {
  dragKeys,
  dropPositionFor,
  isWindowDrag,
  windowDropFor,
  type DropTarget,
} from '../../model/moveSelection';
import type { WindowSide } from '../../model/outline/order';
import type { RowKind as Kind } from './rowProps';

/** A row's drop mark: a tab/group drop position, or `merge` for windows dropped on a window. */
export type DropMark = DropTarget['position'] | 'merge';

export interface RowDragProps {
  draggable: boolean;
  'data-drop'?: DropMark;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

export type RowDrag = (key: string, kind: Kind) => RowDragProps;

/** A window card's drop handlers: the gap below its rows reorders windows dropped there. */
export interface CardDragProps {
  'data-reorder'?: WindowSide;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

/** The "drop for a new window" target's handlers; shown only while tabs (not windows) are dragged. */
export interface NewWindowDropProps {
  'data-over': boolean;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

export interface OutlineDrag {
  row: RowDrag;
  card: (windowKey: string) => CardDragProps;
  newWindow: NewWindowDropProps | null;
}

export interface DragHandlers {
  onSelectOnly: (key: string) => void;
  onMove: (keys: string[], target: DropTarget) => void;
  onReorder: (windowKeys: string[], anchorKey: string, side: WindowSide) => void;
  onNewWindow: (keys: string[]) => void;
}

const MIME = 'application/x-tab-hammer-rows';

const fractionIn = (e: DragEvent<HTMLElement>): number => {
  const r = e.currentTarget.getBoundingClientRect();
  return r.height > 0 ? (e.clientY - r.top) / r.height : 0;
};

/**
 * Drag-and-drop for outline rows. Every row drags (the selection, if the drag starts on a selected
 * row; a window header carries its whole window) and is a drop target, marked with `data-drop`
 * while hovered. A drag of windows alone reorders them when dropped at a window header's top or
 * bottom edge, or in the gap below a window (the card shows `data-reorder`), and merges them into
 * the window when dropped on the header's middle (`data-drop="merge"`). While tabs are dragged, a
 * "new window" target is offered.
 */
export function useRowDrag(selected: ReadonlySet<string>, h: DragHandlers): OutlineDrag {
  const dragging = useRef<string[] | null>(null);
  const [kind, setKind] = useState<'windows' | 'rows' | null>(null);
  const [target, setTarget] = useState<{ key: string; mark: DropMark } | null>(null);
  const [reorder, setReorder] = useState<{ key: string; side: WindowSide } | null>(null);
  const [overNew, setOverNew] = useState(false);

  const end = useCallback(() => {
    dragging.current = null;
    setKind(null);
    setTarget(null);
    setReorder(null);
    setOverNew(false);
  }, []);

  const showTarget = (key: string, mark: DropMark) => {
    setReorder(null);
    setTarget((cur) => (cur?.key === key && cur.mark === mark ? cur : { key, mark }));
  };
  const showReorder = (key: string, side: WindowSide) => {
    setTarget(null);
    setReorder((cur) => (cur?.key === key && cur.side === side ? cur : { key, side }));
  };

  /** What dropping the current drag on this row would do. */
  const dropAt = (
    e: DragEvent<HTMLElement>,
    key: string,
    rowKind: Kind,
  ): { reorder: WindowSide } | { target: DropTarget; mark: DropMark } => {
    const keys = dragging.current ?? [];
    if (rowKind === 'window' && isWindowDrag(keys)) {
      const zone = windowDropFor(fractionIn(e));
      if (zone !== 'merge') return { reorder: zone };
      return { target: { key, position: 'inside' }, mark: 'merge' };
    }
    const position = dropPositionFor(rowKind, fractionIn(e));
    return { target: { key, position }, mark: position };
  };

  const row: RowDrag = (key, rowKind) => ({
    draggable: true,
    'data-drop': target?.key === key ? target.mark : undefined,
    onDragStart: (e) => {
      const keys = dragKeys(selected, key);
      if (!selected.has(key)) h.onSelectOnly(key);
      dragging.current = keys;
      // Changing the page inside dragstart can cancel the drag: the "new window" target appears
      // just after it.
      const dragKind = isWindowDrag(keys) ? 'windows' : 'rows';
      setTimeout(() => {
        if (dragging.current === keys) setKind(dragKind);
      }, 0);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(MIME, keys.join(' '));
    },
    onDragOver: (e) => {
      if (!dragging.current) return; // not one of our rows (e.g. a link dragged in)
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const d = dropAt(e, key, rowKind);
      if ('reorder' in d) showReorder(key, d.reorder);
      else showTarget(key, d.mark);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setTarget((cur) => (cur?.key === key ? null : cur));
      setReorder((cur) => (cur?.key === key ? null : cur));
    },
    onDrop: (e) => {
      const keys = dragging.current;
      if (!keys) return;
      e.preventDefault();
      e.stopPropagation();
      const d = dropAt(e, key, rowKind);
      end();
      if ('reorder' in d) h.onReorder(keys, key, d.reorder);
      else h.onMove(keys, d.target);
    },
    onDragEnd: end,
  });

  // Only the card's own padding (the gap under its last row) is its target: rows handle the rest.
  const inGap = (e: DragEvent<HTMLElement>) =>
    e.target === e.currentTarget && dragging.current !== null && isWindowDrag(dragging.current);

  const card = (windowKey: string): CardDragProps => ({
    'data-reorder': reorder?.key === windowKey ? reorder.side : undefined,
    onDragOver: (e) => {
      if (!inGap(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showReorder(windowKey, 'after');
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setReorder((cur) => (cur?.key === windowKey ? null : cur));
    },
    onDrop: (e) => {
      if (!inGap(e)) return;
      const keys = dragging.current!;
      e.preventDefault();
      end();
      h.onReorder(keys, windowKey, 'after');
    },
  });

  const newWindow: NewWindowDropProps | null =
    kind !== 'rows'
      ? null
      : {
          'data-over': overNew,
          onDragOver: (e) => {
            if (!dragging.current) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setTarget(null);
            setOverNew(true);
          },
          onDragLeave: (e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setOverNew(false);
          },
          onDrop: (e) => {
            const keys = dragging.current;
            if (!keys) return;
            e.preventDefault();
            end();
            h.onNewWindow(keys);
          },
        };

  return { row, card, newWindow };
}

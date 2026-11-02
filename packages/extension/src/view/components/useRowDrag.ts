import { useCallback, useRef, useState, type DragEvent } from 'react';
import { dragKeys, dropPositionFor, type DropTarget } from '../../model/moveSelection';

type Kind = 'window' | 'group' | 'tab';

export interface RowDragProps {
  draggable: boolean;
  'data-drop'?: DropTarget['position'];
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

export type RowDrag = (key: string, kind: Kind) => RowDragProps;

const MIME = 'application/x-tab-hammer-rows';

/**
 * Drag-and-drop for outline rows. Tab rows and group headers drag (the selection, if the drag
 * starts on a selected row); every row is a drop target, marked with `data-drop` while hovered.
 */
export function useRowDrag(
  selected: ReadonlySet<string>,
  onSelectOnly: (key: string) => void,
  onMove: (keys: string[], target: DropTarget) => void,
): RowDrag {
  const dragging = useRef<string[] | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  const end = useCallback(() => {
    dragging.current = null;
    setTarget(null);
  }, []);

  const targetFor = (e: DragEvent<HTMLElement>, key: string, kind: Kind): DropTarget => {
    const r = e.currentTarget.getBoundingClientRect();
    const fraction = r.height > 0 ? (e.clientY - r.top) / r.height : 0;
    return { key, position: dropPositionFor(kind, fraction) };
  };

  return (key, kind) => ({
    draggable: kind !== 'window',
    'data-drop': target?.key === key ? target.position : undefined,
    onDragStart:
      kind === 'window'
        ? undefined
        : (e) => {
            const keys = dragKeys(selected, key);
            if (!selected.has(key)) onSelectOnly(key);
            dragging.current = keys;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(MIME, keys.join(' '));
          },
    onDragOver: (e) => {
      if (!dragging.current) return; // not one of our rows (e.g. a link dragged in)
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const t = targetFor(e, key, kind);
      setTarget((cur) => (cur?.key === t.key && cur.position === t.position ? cur : t));
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setTarget((cur) => (cur?.key === key ? null : cur));
    },
    onDrop: (e) => {
      const keys = dragging.current;
      if (!keys) return;
      e.preventDefault();
      const t = targetFor(e, key, kind);
      end();
      onMove(keys, t);
    },
    onDragEnd: end,
  });
}

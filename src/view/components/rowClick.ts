import type { MouseEvent } from 'react';
import type { SelectionAction } from '../../model/selection';

export function selectionActionFor(
  e: MouseEvent,
  key: string,
  visible: readonly string[],
): SelectionAction {
  if (e.shiftKey) return { type: 'range', key, visible };
  if (e.metaKey || e.ctrlKey) return { type: 'toggle', key };
  return { type: 'click', key };
}

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export type SelectionAction =
  | { type: 'click'; key: string }
  | { type: 'toggle'; key: string }
  | { type: 'range'; key: string; visible: readonly string[] }
  | { type: 'prune'; existing: ReadonlySet<string> };

export const emptySelection: SelectionState = { selected: new Set(), anchor: null };

export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case 'click':
      return { selected: new Set([a.key]), anchor: a.key };
    case 'toggle': {
      const selected = new Set(s.selected);
      if (selected.has(a.key)) selected.delete(a.key);
      else selected.add(a.key);
      return { selected, anchor: a.key };
    }
    case 'range': {
      const from = s.anchor === null ? -1 : a.visible.indexOf(s.anchor);
      const to = a.visible.indexOf(a.key);
      if (from === -1 || to === -1) return { selected: new Set([a.key]), anchor: a.key };
      const [lo, hi] = from < to ? [from, to] : [to, from];
      return { selected: new Set(a.visible.slice(lo, hi + 1)), anchor: s.anchor };
    }
    case 'prune': {
      const selected = new Set([...s.selected].filter((k) => a.existing.has(k)));
      const anchor = s.anchor !== null && a.existing.has(s.anchor) ? s.anchor : null;
      if (selected.size === s.selected.size && anchor === s.anchor) return s;
      return { selected, anchor };
    }
  }
}

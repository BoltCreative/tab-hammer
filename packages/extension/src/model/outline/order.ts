// Window order is Tab Hammer's own (Chrome has none): it is simply the order of `Outline.windows`.
// The store persists it (OutlineMeta.order), a re-linked window keeps its record's place
// (matchRestored replaces it in place), and a sync file lists its windows in this order. These
// ops move window records within it. Pure.
import type { Outline, WindowRec } from './types';

export type WindowSide = 'before' | 'after';

/**
 * Moves the windows `ids` (kept in their current relative order) to just before or after the
 * window `anchorId`. Unchanged when the anchor is unknown or one of the moved windows, or when
 * nothing would move.
 */
export function moveWindows(
  o: Outline,
  ids: readonly string[],
  anchorId: string,
  side: WindowSide,
): Outline {
  const moving = new Set(ids);
  if (moving.has(anchorId)) return o;
  const moved = o.windows.filter((w) => moving.has(w.id));
  if (moved.length === 0) return o;
  const rest = o.windows.filter((w) => !moving.has(w.id));
  const at = rest.findIndex((w) => w.id === anchorId);
  if (at === -1) return o;
  const i = side === 'before' ? at : at + 1;
  const windows = [...rest.slice(0, i), ...moved, ...rest.slice(i)];
  return sameOrder(o.windows, windows) ? o : { windows };
}

/** Moves the window `id` to just after `afterId`, or to the end when `afterId` is null or unknown. */
export function placeWindowAfter(o: Outline, id: string, afterId: string | null): Outline {
  if (afterId !== null && afterId !== id && o.windows.some((w) => w.id === afterId)) {
    return moveWindows(o, [id], afterId, 'after');
  }
  const w = o.windows.find((x) => x.id === id);
  if (!w || o.windows[o.windows.length - 1] === w) return o;
  return { windows: [...o.windows.filter((x) => x !== w), w] };
}

/**
 * Moves the window `id` one place up (-1) or down (+1) among the windows the outline shows
 * (trashed ones are skipped over: they keep their own places). Unchanged at either end.
 */
export function stepWindow(o: Outline, id: string, delta: -1 | 1): Outline {
  const shown = o.windows.filter((w) => w.state !== 'trashed');
  const i = shown.findIndex((w) => w.id === id);
  const neighbour = i === -1 ? undefined : shown[i + delta];
  if (!neighbour) return o;
  return moveWindows(o, [id], neighbour.id, delta < 0 ? 'before' : 'after');
}

function sameOrder(a: readonly WindowRec[], b: readonly WindowRec[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

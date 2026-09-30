const MARGIN = 8; // from the list's edges (the card's left/right margins are in CSS)
const GAP = 4; // from the hovered row

/**
 * The hover card's top edge (viewport coordinates): below the row if it fits, else above it, else
 * pinned inside the scrolling outline list (`bounds`, below the fixed header) so it never spills
 * past an edge or over the header.
 */
export function placeCardTop(
  row: { top: number; bottom: number },
  cardHeight: number,
  bounds: { top: number; bottom: number },
): number {
  const min = bounds.top + MARGIN;
  const max = bounds.bottom - MARGIN;
  const below = row.bottom + GAP;
  if (below + cardHeight <= max) return below;
  const above = row.top - GAP - cardHeight;
  if (above >= min) return above;
  return Math.max(min, Math.min(below, max - cardHeight));
}

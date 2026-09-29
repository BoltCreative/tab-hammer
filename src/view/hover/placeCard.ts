const MARGIN = 8; // from the window edges (the card's left/right margins are in CSS)
const GAP = 4; // from the hovered row

/**
 * The hover card's top edge: below the row if it fits, else above it, else pinned inside the
 * window so it never spills past an edge.
 */
export function placeCardTop(
  row: { top: number; bottom: number },
  cardHeight: number,
  viewportHeight: number,
): number {
  const below = row.bottom + GAP;
  if (below + cardHeight <= viewportHeight - MARGIN) return below;
  const above = row.top - GAP - cardHeight;
  if (above >= MARGIN) return above;
  return Math.max(MARGIN, Math.min(below, viewportHeight - MARGIN - cardHeight));
}

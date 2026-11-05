const MARGIN = 8; // from the list's edges (the card's left/right margins are in CSS)

/**
 * The hover card's top edge (viewport coordinates). The card is pinned to whichever edge of the
 * scrolling outline list (`bounds`, below the fixed header) is farther from the hovered row: the
 * bottom edge for a row in the top half, the top edge for one in the bottom half. So the row and
 * the rows around it, where the pointer goes next, stay uncovered, and since it doesn't need room
 * beside the row this works in the narrow Tab Hammer window too. A card taller than the list is
 * pinned to the list's top; it never spills over the header or past the bottom.
 */
export function placeCardTop(
  row: { top: number; bottom: number },
  cardHeight: number,
  bounds: { top: number; bottom: number },
): number {
  const min = bounds.top + MARGIN;
  const max = bounds.bottom - MARGIN;
  const rowMid = (row.top + row.bottom) / 2;
  const listMid = (bounds.top + bounds.bottom) / 2;
  const top = rowMid < listMid ? max - cardHeight : min;
  return Math.max(min, top);
}

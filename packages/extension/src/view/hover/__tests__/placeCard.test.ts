import { describe, expect, it } from 'vitest';
import { placeCardTop } from '../placeCard';

const LIST = { top: 40, bottom: 800 }; // the scrolling list, below a 40px header
const CARD = 240;
const covers = (top: number, row: { top: number; bottom: number }) =>
  top < row.bottom && top + CARD > row.top;

describe('placeCardTop', () => {
  it('pins the card to the bottom of the list for a row in the top half', () => {
    const row = { top: 100, bottom: 118 };
    expect(placeCardTop(row, CARD, LIST)).toBe(800 - 8 - CARD);
  });

  it('pins the card to the top of the list (under the header) for a row in the bottom half', () => {
    const row = { top: 700, bottom: 718 };
    expect(placeCardTop(row, CARD, LIST)).toBe(48);
  });

  it('leaves the hovered row and several rows on each side uncovered', () => {
    for (let y = LIST.top; y < LIST.bottom - 18; y += 18) {
      const row = { top: y, bottom: y + 18 };
      const top = placeCardTop(row, CARD, LIST);
      // Three 18px rows above and below the hovered one stay clear of the card.
      expect(covers(top, { top: row.top - 54, bottom: row.bottom + 54 })).toBe(false);
    }
  });

  it('never covers the header or spills past the list when the card is taller than it', () => {
    expect(placeCardTop({ top: 100, bottom: 118 }, 900, LIST)).toBe(48);
    expect(placeCardTop({ top: 700, bottom: 718 }, 900, LIST)).toBe(48);
  });
});

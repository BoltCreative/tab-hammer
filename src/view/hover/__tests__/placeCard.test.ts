import { describe, expect, it } from 'vitest';
import { placeCardTop } from '../placeCard';

const WINDOW = { top: 0, bottom: 800 };

describe('placeCardTop', () => {
  it('goes below the row when it fits', () => {
    expect(placeCardTop({ top: 100, bottom: 124 }, 200, WINDOW)).toBe(128);
  });

  it('flips above the row near the bottom of the window', () => {
    expect(placeCardTop({ top: 700, bottom: 724 }, 200, WINDOW)).toBe(496);
  });

  it('stays inside the window when it fits neither below nor above', () => {
    expect(placeCardTop({ top: 300, bottom: 324 }, 600, WINDOW)).toBe(192);
    expect(placeCardTop({ top: 10, bottom: 34 }, 900, WINDOW)).toBe(8);
  });

  it('never covers the fixed header above the list', () => {
    const list = { top: 40, bottom: 800 };
    // Near the list's top, above doesn't fit below the header, so it goes below.
    expect(placeCardTop({ top: 60, bottom: 84 }, 200, list)).toBe(88);
    // Fits neither way: pinned to the list's top, not the window's.
    expect(placeCardTop({ top: 300, bottom: 324 }, 900, list)).toBe(48);
  });
});

import { describe, expect, it } from 'vitest';
import { placeCardTop } from '../placeCard';

describe('placeCardTop', () => {
  it('goes below the row when it fits', () => {
    expect(placeCardTop({ top: 100, bottom: 124 }, 200, 800)).toBe(128);
  });

  it('flips above the row near the bottom of the window', () => {
    expect(placeCardTop({ top: 700, bottom: 724 }, 200, 800)).toBe(496);
  });

  it('stays inside the window when it fits neither below nor above', () => {
    expect(placeCardTop({ top: 300, bottom: 324 }, 600, 800)).toBe(192);
    expect(placeCardTop({ top: 10, bottom: 34 }, 900, 800)).toBe(8);
  });
});

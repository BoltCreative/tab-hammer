import { describe, expect, it } from 'vitest';
import { placeOnScreen } from '../viewBounds';

const laptop = { left: 0, top: 25, width: 1512, height: 920 };
// An external monitor to the right of the laptop.
const external = { left: 1512, top: 0, width: 2560, height: 1415 };

describe('placeOnScreen', () => {
  it('keeps bounds that sit on a screen', () => {
    const saved = { left: 100, top: 60, width: 420, height: 800 };
    expect(placeOnScreen(saved, [laptop, external])).toEqual(saved);
  });

  it('keeps bounds on a secondary screen', () => {
    const saved = { left: 2000, top: 100, width: 420, height: 1200 };
    expect(placeOnScreen(saved, [laptop, external])).toEqual(saved);
  });

  it('moves the window to the primary screen when its screen is gone', () => {
    const saved = { left: 2000, top: 100, width: 420, height: 800 };
    expect(placeOnScreen(saved, [laptop])).toEqual({ left: 40, top: 65, width: 420, height: 800 });
  });

  it('shrinks a window taller than the screen it lands on', () => {
    const saved = { left: 2000, top: 100, width: 420, height: 1300 };
    expect(placeOnScreen(saved, [laptop])).toEqual({ left: 40, top: 25, width: 420, height: 920 });
  });

  it('slides a mostly-visible window fully onto its screen', () => {
    // Hangs off the right edge, but the title bar's left part is still on screen.
    const saved = { left: 1300, top: 60, width: 420, height: 800 };
    expect(placeOnScreen(saved, [laptop])).toEqual({
      left: 1092,
      top: 60,
      width: 420,
      height: 800,
    });
  });

  it('rescues a window whose title bar is above every screen', () => {
    const saved = { left: 100, top: -500, width: 420, height: 800 };
    expect(placeOnScreen(saved, [laptop, external])).toEqual({
      left: 40,
      top: 65,
      width: 420,
      height: 800,
    });
  });

  it('rescues a window with only a sliver on screen', () => {
    const saved = { left: -400, top: 60, width: 420, height: 800 };
    expect(placeOnScreen(saved, [laptop])).toEqual({ left: 40, top: 65, width: 420, height: 800 });
  });

  it('returns the saved bounds when no displays are reported', () => {
    const saved = { left: 100, top: 60, width: 420, height: 800 };
    expect(placeOnScreen(saved, [])).toEqual(saved);
  });
});

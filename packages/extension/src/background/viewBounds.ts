/**
 * Remembers the Tab Hammer window's position and size. The service worker saves the bounds
 * (debounced) whenever the user moves or resizes the view window, and opens the next one at them,
 * pulled back onto a screen if the display they were on is gone.
 */

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const DEFAULT_SIZE = { width: 420, height: 820 };
export const BOUNDS_KEY = 'viewWindowBounds';
export const SAVE_DEBOUNCE_MS = 400;

/** How much of the window's top strip (where the title bar is) must sit on a screen to keep it. */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 30;
/** Inset from the work area's corner when the window has to be moved onto a screen. */
const FALLBACK_INSET = 40;

export function isBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (['left', 'top', 'width', 'height'] as const).every(
    (k) => typeof b[k] === 'number' && Number.isFinite(b[k]),
  );
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Returns where to open the window: the saved bounds if their title strip is on one of the work
 * areas (shrunk to fit that screen), otherwise the saved size (shrunk to fit) near the top-left
 * corner of the primary work area. `workAreas[0]` must be the primary display.
 */
export function placeOnScreen(saved: Bounds, workAreas: Bounds[]): Bounds {
  const primary = workAreas[0];
  if (!primary) return saved;
  const titleStrip = { top: saved.top, bottom: saved.top + MIN_VISIBLE_HEIGHT };
  const home = workAreas.find(
    (a) =>
      overlap(saved.left, saved.left + saved.width, a.left, a.left + a.width) >=
        MIN_VISIBLE_WIDTH &&
      overlap(titleStrip.top, titleStrip.bottom, a.top, a.top + a.height) >= MIN_VISIBLE_HEIGHT,
  );
  if (home) return fitInside(saved, home);
  return fitInside(
    {
      left: primary.left + FALLBACK_INSET,
      top: primary.top + FALLBACK_INSET,
      width: saved.width,
      height: saved.height,
    },
    primary,
  );
}

/** Shrinks the bounds to the area's size, then slides them inside it. */
function fitInside(b: Bounds, area: Bounds): Bounds {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  const left = Math.min(Math.max(b.left, area.left), area.left + area.width - width);
  const top = Math.min(Math.max(b.top, area.top), area.top + area.height - height);
  return { left, top, width, height };
}

/** Bounds to pass to chrome.windows.create for the view window. */
export async function openingBounds(): Promise<Partial<Bounds>> {
  const { [BOUNDS_KEY]: saved } = await chrome.storage.local.get(BOUNDS_KEY);
  if (!isBounds(saved)) return { ...DEFAULT_SIZE };
  const displays = await chrome.system.display.getInfo();
  const workAreas = [...displays]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
    .map((d) => d.workArea);
  return placeOnScreen(saved, workAreas);
}

/** Saves the view window's bounds, debounced, whenever the user moves or resizes it. */
export function trackViewBounds(getViewWindowId: () => Promise<number | undefined>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  chrome.windows.onBoundsChanged.addListener((win) => {
    void (async () => {
      if (win.id === undefined || win.id !== (await getViewWindowId())) return;
      if (win.state !== undefined && win.state !== 'normal') return;
      const bounds = { left: win.left, top: win.top, width: win.width, height: win.height };
      if (!isBounds(bounds)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void chrome.storage.local.set({ [BOUNDS_KEY]: bounds });
      }, SAVE_DEBOUNCE_MS);
    })();
  });
}

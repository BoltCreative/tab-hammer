// Each window's colour in the outline: one of Chrome's tab group colours, picked from the
// window's Tab Hammer ID. That ID is saved with the outline, so a window keeps its colour across
// browser restarts and worker reloads without storing anything new.

export const WINDOW_COLORS = [
  'blue',
  'green',
  'orange',
  'purple',
  'cyan',
  'pink',
  'yellow',
  'red',
] as const;
export type WindowColor = (typeof WINDOW_COLORS)[number];

export function windowColor(id: string): WindowColor {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return WINDOW_COLORS[Math.abs(h) % WINDOW_COLORS.length]!;
}

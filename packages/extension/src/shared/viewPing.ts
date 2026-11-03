/**
 * The service worker asks "is the Tab Hammer view alive?" before reusing its window. A view whose
 * scripts never ran (left blank by an extension reload) has no listener, so the ask fails.
 */
export const VIEW_PING = 'tabHammer:viewPing';

export function isViewPing(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === VIEW_PING;
}

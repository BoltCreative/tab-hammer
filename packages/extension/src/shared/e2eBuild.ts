/**
 * True in the e2e build (`npm run build:e2e`, Vite mode `e2e`), which the Playwright suite loads.
 * Only test determinism may hang off it: timers the app owns that a test would otherwise have to
 * outwait or outrun are stepped by test hooks or switched off instead. Never product behaviour.
 */
export const E2E_BUILD = import.meta.env.MODE === 'e2e';

/** The longest delay setTimeout takes (about 24.8 days): in effect, never. */
const NEVER_MS = 2 ** 31 - 1;

/**
 * A time limit, off in the e2e build. Limits that give up on a hung Chrome call (or clear a status
 * after a while) are for users' machines; in a test, a slow machine must not trip one and change
 * what the test sees. Their own unit tests step them with fake clocks.
 */
export const limitMs = (ms: number): number => (E2E_BUILD ? NEVER_MS : ms);

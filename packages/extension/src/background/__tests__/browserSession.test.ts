import { describe, expect, it } from 'vitest';
import { createBrowserSession, type KeyValueStore } from '../browserSession';
import { createTabCapturer, type OffscreenDeps } from '../debuggerCapture';

/** chrome.storage.local stand-in: it outlives any one "extension instance" built on it. */
function localStore(): KeyValueStore {
  const data: Record<string, unknown> = {};
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
}

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('createBrowserSession', () => {
  it('keeps its ID across an extension reload and renews it when the browser restarts', async () => {
    const store = localStore();
    const newId = ids();
    const before = await createBrowserSession(store, newId).current();
    // An extension reload builds a fresh instance on the same storage; onStartup doesn't fire.
    const reloaded = createBrowserSession(store, newId);
    expect(await reloaded.current()).toBe(before);
    // A browser launch fires onStartup, which renews it.
    await reloaded.renew();
    expect(await reloaded.current()).not.toBe(before);
  });
});

describe('swap recovery across an extension reload vs a browser restart', () => {
  const WINDOW = 7;
  async function recoverAfter(restart: boolean) {
    const store = localStore();
    const newId = ids();
    const session = await createBrowserSession(store, newId).current();
    const record = {
      session,
      windowId: WINDOW,
      targetId: 70,
      standInId: 71,
      knownTabIds: [70, 71],
      at: 1000,
    };
    const reloaded = createBrowserSession(store, newId);
    if (restart) await reloaded.renew();
    const calls: string[] = [];
    const tab = (id: number, active: boolean) => ({
      id,
      windowId: WINDOW,
      index: id - 70,
      groupId: -1,
      url: 'https://example.com/',
      status: 'complete' as const,
      incognito: false,
      discarded: false,
      active,
    });
    // Only what recovery touches.
    const deps: Partial<OffscreenDeps> = {
      loadSwap: async () => record,
      saveSwap: async (r) => void calls.push(r ? 'saveSwap' : 'clearSwap'),
      sessionId: () => reloaded.current(),
      tabsInWindow: async () => [tab(70, false), tab(71, true)],
      activate: async (id) => void calls.push(`activate(${id})`),
      removeTab: async (id) => void calls.push(`removeTab(${id})`),
      now: () => 2000,
    };
    await createTabCapturer(deps as OffscreenDeps).recover();
    return calls;
  }

  it('undoes the swap after an extension reload (same browser session)', async () => {
    expect(await recoverAfter(false)).toEqual(['activate(70)', 'clearSwap']);
  });

  it('drops the record without acting after a browser restart', async () => {
    expect(await recoverAfter(true)).toEqual(['clearSwap']);
  });
});

import { describe, expect, it } from 'vitest';
import { createBrowserSession, type BrowserSession, type KeyValueStore } from '../browserSession';
import type { SwapRecord } from '../../shared/captureSwap';
import { createTabCapturer, type OffscreenDeps } from '../debuggerCapture';

/** A chrome.storage area stand-in that outlives any one "service worker instance" built on it. */
function memStore(): KeyValueStore & { clear(): void } {
  let data: Record<string, unknown> = {};
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
    clear: () => void (data = {}),
  };
}

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

/** Timers that fire only when the test says so. */
function manualTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => void pending.push(fn),
    fireAll: () => pending.splice(0).forEach((fn) => fn()),
  };
}

/** Browser storage, and a way to start a new service worker on it (as Chrome would). */
function browser() {
  const local = memStore(); // chrome.storage.local: survives everything
  const session = memStore(); // chrome.storage.session: gone on browser restart or ext reload
  const newId = ids();
  const timers = manualTimers();
  return {
    timers,
    restartBrowser: () => session.clear(),
    reloadExtension: () => session.clear(),
    worker: () => createBrowserSession({ local, session, newId, setTimer: timers.setTimer }),
  };
}

const settled = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

describe('createBrowserSession', () => {
  it('keeps its ID across an extension reload and renews it when the browser restarts', async () => {
    const b = browser();
    const first = b.worker();
    await first.installed();
    const before = await first.current();

    b.reloadExtension();
    const reloaded = b.worker();
    await reloaded.installed(); // onInstalled fires on reload; onStartup doesn't
    expect(await reloaded.current()).toBe(before);

    b.restartBrowser();
    const launched = b.worker();
    await launched.launched();
    expect(await launched.current()).not.toBe(before);
  });

  it('a worker woken later in the same session answers at once', async () => {
    const b = browser();
    const first = b.worker();
    await first.installed();
    const id = await first.current();
    // Idle shutdown and wake: storage.session persists, no lifecycle event fires.
    expect(await b.worker().current()).toBe(id);
  });

  it('after a browser launch, waits for onStartup instead of handing out the old ID', async () => {
    const b = browser();
    const first = b.worker();
    await first.installed();
    const old = await first.current();

    b.restartBrowser();
    const w = b.worker();
    const early = w.current(); // a capture request beat onStartup
    expect(await settled(early)).toBe(false);
    await w.launched();
    expect(await early).not.toBe(old);
  });

  it('starts a new session if no lifecycle event comes (extension re-enabled)', async () => {
    const b = browser();
    const first = b.worker();
    await first.installed();
    const old = await first.current();

    b.reloadExtension(); // disable + enable clears storage.session and fires nothing
    const w = b.worker();
    const pending = w.current();
    expect(await settled(pending)).toBe(false);
    b.timers.fireAll();
    const fresh = await pending;
    expect(fresh).not.toBe(old);
    // A late onStartup doesn't replace the session the worker already started.
    await w.launched();
    expect(await w.current()).toBe(fresh);
  });
});

describe('swap recovery across an extension reload vs a browser restart', () => {
  const WINDOW = 7;
  async function recoverAfter(restart: boolean) {
    const b = browser();
    const first = b.worker();
    await first.installed();
    const session = await first.current();
    const record = {
      session,
      windowId: WINDOW,
      targetId: 70,
      standInId: 71,
      knownTabIds: [70, 71],
      at: 1000,
    };
    if (restart) b.restartBrowser();
    else b.reloadExtension();
    const reloaded = b.worker();
    // The hover card's capture request (which runs recovery) reaches the new worker first; the
    // lifecycle event for the restart or reload follows.
    const calls: string[] = [];
    const recovered = createTabCapturer(depsFor(reloaded, calls, record)).recover();
    await (restart ? reloaded.launched() : reloaded.installed());
    await recovered;
    return calls;
  }

  function depsFor(reloaded: BrowserSession, calls: string[], record: SwapRecord) {
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
    return deps as OffscreenDeps;
  }

  it('undoes the swap after an extension reload (same browser session)', async () => {
    expect(await recoverAfter(false)).toEqual(['activate(70)', 'clearSwap']);
  });

  it('drops the record without acting after a browser restart', async () => {
    expect(await recoverAfter(true)).toEqual(['clearSwap']);
  });
});

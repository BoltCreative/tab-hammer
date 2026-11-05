import { describe, expect, it } from 'vitest';
import { restoreWindows } from '../../../model/sync/restore';
import type { SyncWindow } from '../../../model/sync/export';
import { stab, swin } from '../../../model/sync/__tests__/files';
import type { SessionDeviceLike } from '../../../model/sync/devices';
import { toSyncWindow } from '../../../model/sync/export';
import { AuthError, outlineFileName, type SyncBackend } from '../backend';
import { createMemoryBackend, type MemoryBackend } from '../memoryBackend';
import { createSyncEngine, PUSH_DELAY_MS, type SyncEngine } from '../syncEngine';
import { createMemorySyncStore } from '../syncStore';

/** A clock and timers the test moves by hand. */
function fakeClock(start = new Date(2026, 10, 5, 12).getTime()) {
  let now = start;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clear: (h: unknown) => void (timers = timers.filter((t) => t.id !== h)),
    },
    pending: () => timers.length,
    /** Moves time forward, firing timers that come due. */
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
    set: (t: number) => void (now = t),
  };
}

type Clock = ReturnType<typeof fakeClock>;

/** One simulated install: an in-memory outline of sync windows and a sync engine. */
function install(
  id: string,
  backend: SyncBackend | null,
  clock: Clock,
  opts: {
    windows?: SyncWindow[];
    fresh?: boolean;
    store?: ReturnType<typeof createMemorySyncStore>;
    devices?: SessionDeviceLike[];
  } = {},
) {
  const state = { windows: opts.windows ?? [] };
  const store = opts.store ?? createMemorySyncStore();
  const restores: { windows: SyncWindow[]; keepTrash: boolean }[] = [];
  let n = 0;
  const engine: SyncEngine = createSyncEngine({
    installId: async () => id,
    platform: async () => 'mac',
    backend: () => backend,
    signIn: async () => undefined,
    outline: {
      windows: async () => structuredClone(state.windows),
      restore: async (windows, keepTrash) => {
        restores.push({ windows, keepTrash });
        const r = restoreWindows({ windows: state.windows.map((w) => ({ ...w })) }, windows, {
          now: clock.now(),
          newId: () => `${id}-new-${++n}`,
          keepTrash,
        });
        state.windows = r.outline.windows.map(toSyncWindow);
        engine.noteChange();
        return r.added.length;
      },
      wasFresh: async () => opts.fresh ?? false,
    },
    devices: async () => opts.devices ?? [],
    store,
    now: clock.now,
    timers: clock.timers,
    onError: () => undefined,
  });
  return {
    engine,
    state,
    store,
    restores,
    /** Changes the outline and tells the engine, as the outline owner does. */
    change(windows: SyncWindow[]) {
      state.windows = windows;
      engine.noteChange();
    },
  };
}

const fileOf = (b: MemoryBackend, id: string) => {
  const f = b.files.get(outlineFileName(id));
  return f && JSON.parse(f.content);
};

describe('sync engine', () => {
  it('pushes 10s after the last change, once', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock);
    await a.engine.start();
    const writes = () => backend.files.get(outlineFileName('a'))?.modifiedTime;
    const first = writes();
    expect(fileOf(backend, 'a').windows).toEqual([]); // a new computer uploads its (empty) file

    a.change([swin('w1')]);
    clock.advance(PUSH_DELAY_MS - 1);
    a.change([swin('w1'), swin('w2')]); // restarts the wait
    clock.advance(PUSH_DELAY_MS - 1);
    await a.engine.idle();
    expect(writes()).toBe(first);
    clock.advance(1);
    await a.engine.idle();
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1', 'w2']);
    expect(await a.store.flags()).toMatchObject({ dirty: false });
  });

  it("another install sees this computer's outline after pulling", async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, {
      windows: [swin('w1', { tabs: [stab('t1'), stab('t2')] })],
    });
    const b = install('b', backend, clock);
    await a.engine.start();
    await b.engine.sync();
    const state = await b.engine.pickerState();
    expect(state.computers).toEqual([
      { installId: 'a', name: 'Mac', updatedAt: clock.now(), windowCount: 1, tabCount: 2 },
    ]);
    expect(state.self).toEqual({ installId: 'b', name: 'Mac' });
    const remote = await b.engine.outlineOf({ kind: 'computer', installId: 'a' });
    expect(remote.windows.map((w) => w.id)).toEqual(['w1']);
  });

  it('downloads only files whose modified time changed, and drops vanished ones', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, { windows: [swin('w1')] });
    const b = install('b', backend, clock);
    await a.engine.start();
    await b.engine.sync();
    backend.reads = [];
    await b.engine.sync();
    expect(backend.reads).toEqual([]);
    clock.advance(1000);
    a.change([swin('w1'), swin('w2')]);
    await a.engine.flushNow();
    await b.engine.sync();
    expect(backend.reads).toEqual([outlineFileName('a')]);
    backend.files.delete(outlineFileName('a'));
    await b.engine.sync();
    expect((await b.engine.pickerState()).computers).toEqual([]);
  });

  it('offline: the push fails, stays dirty, and goes through once back online', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock);
    await a.engine.start();
    backend.offline = true;
    a.change([swin('w1')]);
    await a.engine.flushNow();
    let state = await a.engine.pickerState();
    expect(state.drive.status).toBe('error');
    expect(await a.store.flags()).toMatchObject({ dirty: true });
    backend.offline = false;
    await a.engine.sync();
    state = await a.engine.pickerState();
    expect(state.drive.status).toBe('ok');
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1']);
    expect(await a.store.flags()).toMatchObject({ dirty: false });
  });

  it('a dirty flag left by a worker that died before pushing is pushed on start', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const store = createMemorySyncStore();
    const a = install('a', backend, clock, { store });
    await a.engine.start();
    a.change([swin('w1')]);
    await a.engine.idle(); // dirty recorded, push still waiting
    // The worker dies here; a new one starts on the same store.
    const again = install('a', backend, clock, { store, windows: [swin('w1')] });
    await again.engine.start();
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1']);
  });

  it('signed out: status says so and nothing is pushed', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    backend.list = async () => {
      throw new AuthError('no token');
    };
    backend.write = async () => {
      throw new AuthError('no token');
    };
    const a = install('a', backend, clock, { windows: [swin('w1')] });
    await a.engine.start();
    expect((await a.engine.pickerState()).drive.status).toBe('signedOut');
  });

  it('Drive off: no backend, status off, checkpoints still taken locally', async () => {
    const clock = fakeClock();
    const a = install('a', null, clock, { windows: [swin('w1')] });
    await a.engine.start();
    const state = await a.engine.pickerState();
    expect(state.drive.status).toBe('off');
    expect(state.checkpoints).toHaveLength(1);
  });

  it('skips a corrupt file and one from a newer Tab Hammer, and reports them', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    await backend.write(outlineFileName('bad'), '{not json');
    await backend.write(
      outlineFileName('future'),
      JSON.stringify({ schemaVersion: 99, installId: 'future' }),
    );
    await backend.write(
      outlineFileName('liar'),
      JSON.stringify({
        ...{
          schemaVersion: 1,
          installId: 'someone-else',
          computerName: 'x',
          platform: 'mac',
          updatedAt: 1,
          windows: [],
        },
      }),
    );
    const b = install('b', backend, clock);
    await b.engine.sync();
    const state = await b.engine.pickerState();
    expect(state.computers.map((c) => [c.installId, c.problem])).toEqual(
      expect.arrayContaining([
        ['bad', 'malformed'],
        ['future', 'newer'],
        ['liar', 'malformed'],
      ]),
    );
    expect(state.drive.skipped).toHaveLength(3);
    expect(state.drive.skipped.some((s) => s.includes('needs a newer Tab Hammer'))).toBe(true);
    await expect(b.engine.outlineOf({ kind: 'computer', installId: 'bad' })).rejects.toThrow();
    await expect(b.engine.restoreAll({ kind: 'computer', installId: 'bad' })).rejects.toThrow();
    expect(b.restores).toEqual([]);
  });

  it('never uploads an invalid outline', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, { windows: [swin('w1'), swin('w1')] }); // duplicate IDs
    await a.engine.start();
    expect(backend.files.has(outlineFileName('a'))).toBe(false);
    const state = await a.engine.pickerState();
    expect(state.drive).toMatchObject({ status: 'error' });
    expect(state.drive.message).toMatch(/invalid outline/);
  });

  it("Forget deletes the other computer's file and checkpoints; a live computer re-uploads", async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, { windows: [swin('w1')] });
    const b = install('b', backend, clock);
    await a.engine.start();
    await b.engine.sync();
    expect([...backend.files.keys()].some((n) => n.startsWith('checkpoint-a-'))).toBe(true);
    await b.engine.forget('a');
    expect([...backend.files.keys()].filter((n) => n.includes('-a'))).toEqual([]);
    expect((await b.engine.pickerState()).computers).toEqual([]);
    await a.engine.sync();
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1']);
  });

  it('Restore all (take-over) adds the missing windows, checkpoints first, then retires the file', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const old = install('old', backend, clock, {
      windows: [
        swin('w1', { state: 'live' }),
        swin('w2'),
        swin('t', { state: 'trashed', closedAt: 1 }),
      ],
    });
    await old.engine.start();
    const b = install('b', backend, clock, { windows: [swin('mine'), swin('w2')] });
    await b.engine.start();
    await b.engine.sync();
    const added = await b.engine.restoreAll({ kind: 'computer', installId: 'old' });
    expect(added).toBe(1);
    expect(b.state.windows.map((w) => [w.id, w.state])).toEqual([
      ['mine', 'hibernated'],
      ['w2', 'hibernated'],
      ['w1', 'hibernated'],
    ]);
    const cps = (await b.engine.pickerState()).checkpoints;
    expect(cps.some((c) => c.drastic && c.windowCount === 2)).toBe(true);
    await b.engine.forget('old');
    expect(backend.files.has(outlineFileName('old'))).toBe(false);
  });

  it('self-restore: an empty outline database brings back its own file, trash kept, before any push', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const before = install('a', backend, clock, {
      windows: [swin('w1', { state: 'live' }), swin('t', { state: 'trashed', closedAt: 5 })],
    });
    await before.engine.start();
    await before.engine.rename('Desk');
    await before.engine.flushNow();
    const pushed = fileOf(backend, 'a');

    // The profile's outline and sync databases are wiped; the install ID survived.
    let wroteOwnBeforeRestore = false;
    const write = backend.write.bind(backend);
    const after = install('a', backend, clock, {
      fresh: true,
      windows: [swin('fresh-live', { state: 'live' })],
    });
    backend.write = async (name, content) => {
      if (name === outlineFileName('a') && after.restores.length === 0)
        wroteOwnBeforeRestore = true;
      return write(name, content);
    };
    after.change([swin('fresh-live', { state: 'live' })]);
    clock.advance(PUSH_DELAY_MS); // a push comes due before the pull; it must wait
    await after.engine.start();
    expect(wroteOwnBeforeRestore).toBe(false);
    expect(after.restores).toEqual([{ windows: pushed.windows, keepTrash: true }]);
    expect(after.state.windows.map((w) => [w.id, w.state])).toEqual([
      ['fresh-live', 'live'],
      ['w1', 'hibernated'],
      ['t', 'trashed'],
    ]);
    expect((await after.engine.pickerState()).self.name).toBe('Desk');
    const drastic = (await after.engine.pickerState()).checkpoints.filter((c) => c.drastic);
    expect(drastic.length).toBeGreaterThanOrEqual(2);
    // And the restored outline is pushed afterwards.
    await after.engine.flushNow();
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual([
      'fresh-live',
      'w1',
      't',
    ]);
  });

  it('self-restore with no file of its own just carries on (a new computer)', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, { fresh: true, windows: [swin('w1')] });
    await a.engine.start();
    expect(a.restores).toEqual([]);
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1']);
  });

  it('self-restore waits while offline, and holds every push until it has checked', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    await install('a', backend, clock, { windows: [swin('w1')] }).engine.start();
    backend.offline = true;
    const after = install('a', backend, clock, { fresh: true });
    await after.engine.start();
    backend.offline = false;
    after.change([swin('other')]);
    await after.engine.flushNow();
    expect(fileOf(backend, 'a').windows.map((w: SyncWindow) => w.id)).toEqual(['w1']); // untouched
    await after.engine.sync();
    expect(after.restores).toHaveLength(1);
  });

  it('takes a checkpoint of the last pushed outline before a push that drops most windows', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock, { windows: [swin('w1'), swin('w2'), swin('w3')] });
    await a.engine.start();
    a.change([swin('w3')]);
    await a.engine.flushNow();
    const cps = (await a.engine.pickerState()).checkpoints;
    const drastic = cps.filter((c) => c.drastic);
    expect(drastic).toHaveLength(1);
    expect(drastic[0]!.windowCount).toBe(3);
    const view = await a.engine.outlineOf({ kind: 'checkpoint', id: drastic[0]!.id });
    expect(view.windows.map((w) => w.id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('takes one everyday checkpoint a day, only when the outline changed', async () => {
    const clock = fakeClock(new Date(2026, 10, 5, 9).getTime());
    const a = install('a', null, clock, { windows: [swin('w1')] });
    await a.engine.start();
    a.change([swin('w1'), swin('w2')]);
    await a.engine.flushNow(); // same day: no second one
    expect((await a.engine.pickerState()).checkpoints).toHaveLength(1);
    clock.set(new Date(2026, 10, 6, 9).getTime());
    await a.engine.sync();
    expect((await a.engine.pickerState()).checkpoints).toHaveLength(2);
    clock.set(new Date(2026, 10, 7, 9).getTime());
    await a.engine.sync(); // unchanged since yesterday's
    expect((await a.engine.pickerState()).checkpoints).toHaveLength(2);
  });

  it('prunes checkpoints to the retention, locally and in Drive', async () => {
    const clock = fakeClock(new Date(2026, 0, 1, 9).getTime());
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock);
    for (let day = 0; day < 40; day++) {
      clock.set(new Date(2026, 0, 1 + day, 9).getTime());
      a.change([swin(`w${day}`)]);
      await a.engine.flushNow();
    }
    const cps = (await a.engine.pickerState()).checkpoints;
    expect(cps.length).toBeLessThanOrEqual(14 + 8);
    expect(cps.length).toBeGreaterThan(14);
    const inDrive = [...backend.files.keys()].filter((n) => n.startsWith('checkpoint-a-'));
    expect(inDrive.sort()).toEqual(cps.map((c) => c.id).sort());
  });

  it('a renamed computer pushes its new name', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock);
    await a.engine.start();
    await a.engine.rename('  Studio  ');
    clock.advance(PUSH_DELAY_MS);
    await a.engine.idle();
    expect(fileOf(backend, 'a').computerName).toBe('Studio');
    await a.engine.rename('');
    await a.engine.flushNow();
    expect(fileOf(backend, 'a').computerName).toBe('Mac');
  });

  it('lists Chrome Sync devices, minus the one named like a Tab Hammer computer', async () => {
    const clock = fakeClock();
    const backend = createMemoryBackend(clock.now);
    const a = install('a', backend, clock);
    await a.engine.start();
    await a.engine.rename('Studio');
    await a.engine.flushNow();
    const tabs = [{ sessionId: 's1', url: 'https://x.test/', title: 'X' }];
    const b = install('b', backend, clock, {
      devices: [
        { deviceName: 'Studio', sessions: [{ lastModified: 1, window: { sessionId: 'w', tabs } }] },
        { deviceName: 'iPhone', sessions: [{ lastModified: 2, window: { sessionId: 'p', tabs } }] },
      ],
    });
    await b.engine.sync();
    const state = await b.engine.pickerState();
    expect(state.computers.map((c) => c.name)).toEqual(['Studio']);
    expect(state.devices.map((d) => d.name)).toEqual(['iPhone']);
    const phone = await b.engine.outlineOf({ kind: 'device', name: 'iPhone' });
    expect(phone.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://x.test/']);
  });
});

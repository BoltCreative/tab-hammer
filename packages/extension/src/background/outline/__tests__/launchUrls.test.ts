import { describe, expect, it } from 'vitest';
import { createLaunchUrls, type SessionStore } from '../launchUrls';

/** An in-memory chrome.storage.session whose reads resolve only when released. */
function fakeStore(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial };
  const pendingReads: (() => void)[] = [];
  const store: SessionStore = {
    getAll: () => new Promise((r) => pendingReads.push(() => r({ ...data }))),
    set: async (items) => void Object.assign(data, items),
    remove: async (keys) => keys.forEach((k) => delete data[k]),
  };
  const releaseReads = () => pendingReads.splice(0).forEach((r) => r());
  return { data, store, releaseReads };
}

const fail = (err: unknown) => {
  throw err;
};

describe('launch URLs', () => {
  it('a tab noted before the stored entries load leaves the earlier entries intact', async () => {
    const { data, store, releaseReads } = fakeStore({
      'launchUrl:1': 'https://a.example/',
      'launchUrl:2': 'https://b.example/',
      other: 'kept',
    });
    const l = createLaunchUrls(store, fail);
    // The worker wakes on a new tab's event and notes it before init reads storage.
    l.note(3, 'https://c.example/');
    const loading = l.load();
    releaseReads();
    await loading;

    expect(Object.fromEntries(l.urls)).toEqual({
      1: 'https://a.example/',
      2: 'https://b.example/',
      3: 'https://c.example/',
    });
    expect(data).toEqual({
      'launchUrl:1': 'https://a.example/',
      'launchUrl:2': 'https://b.example/',
      'launchUrl:3': 'https://c.example/',
      other: 'kept',
    });
  });

  it('the stored (first) launch URL wins over one noted after the worker woke', async () => {
    const { data, store, releaseReads } = fakeStore({ 'launchUrl:1': 'https://first.example/' });
    const l = createLaunchUrls(store, fail);
    l.note(1, 'https://redirected.example/'); // its committed navigation woke the worker
    const loading = l.load();
    releaseReads();
    await loading;
    expect(l.urls.get(1)).toBe('https://first.example/');
    expect(data['launchUrl:1']).toBe('https://first.example/');
  });

  it('a tab removed before the load is not brought back, and its key goes', async () => {
    const { data, store, releaseReads } = fakeStore({ 'launchUrl:1': 'https://a.example/' });
    const l = createLaunchUrls(store, fail);
    l.forget(1);
    const loading = l.load();
    releaseReads();
    await loading;
    expect(l.urls.has(1)).toBe(false);
    expect(data).toEqual({});
  });

  it('after loading, notes and removals write their own key', async () => {
    const { data, store, releaseReads } = fakeStore({ 'launchUrl:1': 'https://a.example/' });
    const l = createLaunchUrls(store, fail);
    const loading = l.load();
    releaseReads();
    await loading;
    l.note(2, 'https://b.example/');
    l.note(2, 'https://later.example/'); // first wins
    l.forget(1);
    await Promise.resolve();
    expect(data).toEqual({ 'launchUrl:2': 'https://b.example/' });
  });
});

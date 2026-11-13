import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import {
  expect,
  launchWithExtension,
  loadedTabUrls,
  outlineCommand,
  readOutline,
  relaunch,
  serviceWorkerOf,
  settle,
  startPageServer,
  test,
  type PageServer,
} from './fixtures';

// These tests close and relaunch a real (headless) Chromium on one profile. A fresh launch is
// detected here through onInstalled('install') (--load-extension reinstalls on each launch);
// onStartup and chrome_update are covered by the browserSession unit tests.

// A restored window is matched once it settles. The e2e build has no quiet period for that: each
// test waits until Chrome has restored (and loaded) what it expects, then settles explicitly, so a
// slow machine can't have a half-restored window matched.

/** A temp profile and page server, removed after `body` however it ends. */
async function withProfile(body: (dir: string, pages: PageServer) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-hammer-restart-'));
  const pages = await startPageServer();
  try {
    await body(dir, pages);
  } finally {
    await pages.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Opens a window of the given URLs, grouping the first `group.size` tabs; returns its Chrome ID. */
function openWindow(sw: Worker, urls: string[], group?: { size: number; title: string }) {
  return sw.evaluate(
    async ({ urls, group }) => {
      const w = await chrome.windows.create({ url: urls });
      if (group) {
        const tabs = await chrome.tabs.query({ windowId: w!.id });
        const groupId = await chrome.tabs.group({
          tabIds: tabs.slice(0, group.size).map((t) => t.id!) as [number, ...number[]],
          createProperties: { windowId: w!.id },
        });
        await chrome.tabGroups.update(groupId, { title: group.title });
      }
      return w!.id!;
    },
    { urls, group },
  );
}

/** The live record of a Chrome window, once its tabs have loaded with these titles. */
async function loadedRecord(sw: Worker, chromeWindowId: number, titles: string[]) {
  const find = async () =>
    (await readOutline(sw)).windows.find(
      (w) => w.state === 'live' && w.chromeWindowId === chromeWindowId,
    );
  await expect.poll(async () => (await find())?.tabs.map((t) => t.title)).toEqual(titles);
  return (await find())!;
}

/** How a saved record came back: its state, name, tabs, and how many records hold its window. */
async function comeback(sw: Worker, id: string) {
  const { windows } = await readOutline(sw);
  const rec = windows.find((w) => w.id === id);
  return {
    state: rec?.state,
    name: rec?.name,
    tabs: rec?.tabs.map((t) => ({ id: t.id, live: t.chromeTabId !== undefined })),
    groups: rec?.groups.map((g) => ({
      id: g.id,
      title: g.title,
      live: g.chromeGroupId !== undefined,
    })),
    holders: windows.filter(
      (w) => rec?.chromeWindowId !== undefined && w.chromeWindowId === rec.chromeWindowId,
    ).length,
  };
}

/**
 * How many window records the test's own windows have, and how many of those are in the trash: a
 * restored window that came back as a second record (live, or trashed) shows up here. Playwright's
 * about:blank startup window has records of its own (see relaunch), so it's left out.
 */
async function ownRecords(sw: Worker): Promise<{ records: number; trashed: number }> {
  const own = (await readOutline(sw)).windows.filter(
    (w) => !w.tabs.every((t) => t.url === 'about:blank'),
  );
  return { records: own.length, trashed: own.filter((w) => w.state === 'trashed').length };
}

const liveTabs = (rec: WindowRec) => rec.tabs.map((t) => ({ id: t.id, live: true }));

test('a browser restart re-links restored windows to their rows', async () => {
  await withProfile(async (dir, pages) => {
    const first = await launchWithExtension(dir);
    let sw = await serviceWorkerOf(first);
    const a = await openWindow(sw, ['A1', 'A2', 'A3'].map(pages.url), { size: 2, title: 'Group' });
    const b = await openWindow(sw, ['B1', 'B2'].map(pages.url));
    const recA = await loadedRecord(sw, a, ['A1', 'A2', 'A3']);
    const recB = await loadedRecord(sw, b, ['B1', 'B2']);
    await outlineCommand(sw, { cmd: 'rename', windowId: recA.id, name: 'Work' });
    await expect
      .poll(async () => (await comeback(sw, recA.id)).groups)
      .toEqual([{ id: expect.any(String), title: 'Group', live: true }]);
    const groupA = (await comeback(sw, recA.id)).groups![0]!.id;
    await first.close();

    const second = await relaunch(dir);
    try {
      sw = second.sw;
      await expect
        .poll(() => loadedTabUrls(sw))
        .toEqual(
          expect.arrayContaining([['A1', 'A2', 'A3'].map(pages.url), ['B1', 'B2'].map(pages.url)]),
        );
      await expect
        .poll(() => sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title)))
        .toEqual(['Group']);
      await settle(sw);
      expect([await comeback(sw, recA.id), await comeback(sw, recB.id)]).toEqual([
        {
          state: 'live',
          name: 'Work',
          tabs: liveTabs(recA),
          groups: [{ id: groupA, title: 'Group', live: true }],
          holders: 1,
        },
        { state: 'live', name: undefined, tabs: liveTabs(recB), groups: [], holders: 1 },
      ]);
      expect(await ownRecords(sw)).toEqual({ records: 2, trashed: 0 });
    } finally {
      await second.context.close();
    }
  });
});

test('a restored window with a hibernated tab re-links, and that tab stays hibernated', async () => {
  await withProfile(async (dir, pages) => {
    const first = await launchWithExtension(dir);
    let sw = await serviceWorkerOf(first);
    const d = await openWindow(sw, ['D1', 'D2', 'D3'].map(pages.url));
    const recD = await loadedRecord(sw, d, ['D1', 'D2', 'D3']);
    const [d1, d2, d3] = recD.tabs;
    await outlineCommand(sw, { cmd: 'hibernate', ids: [d2!.id] });
    const tabs = [
      { id: d1!.id, live: true },
      { id: d2!.id, live: false },
      { id: d3!.id, live: true },
    ];
    await expect.poll(async () => (await comeback(sw, recD.id)).tabs).toEqual(tabs);
    await first.close();

    // Chrome restores the window with D1 and D3 only; D2's row must come back in place, dimmed.
    const second = await relaunch(dir);
    try {
      sw = second.sw;
      await expect
        .poll(() => loadedTabUrls(sw))
        .toEqual(expect.arrayContaining([['D1', 'D3'].map(pages.url)]));
      await settle(sw);
      expect(await comeback(sw, recD.id)).toEqual({
        state: 'live',
        name: undefined,
        tabs,
        groups: [],
        holders: 1,
      });
      expect(await ownRecords(sw)).toEqual({ records: 1, trashed: 0 });
    } finally {
      await second.context.close();
    }
  });
});

/** Marks the running worker instance, so a test can tell when a new instance has replaced it. */
const markWorker = (sw: Worker) =>
  sw.evaluate(() => ((globalThis as unknown as { testMark?: boolean }).testMark = true));
const isMarkedWorker = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as { testMark?: boolean }).testMark === true);

test('a rename survives a service-worker restart', async ({ context, sw, view }) => {
  const a = await sw.evaluate(
    async (urls) => (await chrome.windows.create({ url: urls }))!.id!,
    ['data:text/html,<title>One</title>', 'data:text/html,<title>Two</title>'],
  );
  const rec = await loadedRecord(sw, a, ['One', 'Two']);
  const header = view.locator(`[data-key="w:${rec.id}"]`);
  await header.hover();
  await header.getByRole('button', { name: 'Rename window', exact: true }).click();
  await header.getByRole('textbox').fill('Reading');
  await header.getByRole('textbox').press('Enter');
  await expect.poll(async () => (await comeback(sw, rec.id)).name).toBe('Reading');

  await markWorker(sw);
  expect(await isMarkedWorker(sw)).toBe(true);
  const cdp = await context.newCDPSession(view);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  // Chrome starts a new instance on the same target (the view reconnecting wakes it), so
  // Playwright's handle reaches it and no new serviceworker event fires.
  await expect.poll(() => isMarkedWorker(sw)).toBe(false);

  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      const r = windows.find((w) => w.id === rec.id);
      return {
        state: r?.state,
        name: r?.name,
        chromeWindowId: r?.chromeWindowId,
        trashed: windows.filter((w) => w.state === 'trashed').length,
      };
    })
    .toEqual({ state: 'live', name: 'Reading', chromeWindowId: a, trashed: 0 });
  await expect(header.locator('.title')).toHaveText('Reading');
});

/**
 * Kills every Chromium process running on `dir` with SIGKILL, the way the OS kills a browser that
 * runs the machine out of memory: no window closes, no event fires, nothing shuts down.
 */
async function killChromium(dir: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const pids = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${dir}`))
    .map((line) => Number.parseInt(line.trim(), 10));
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone with its parent.
    }
  }
  await expect
    .poll(
      () =>
        pids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }).length,
    )
    .toBe(0);
}

/**
 * Relaunches Chromium on `dir` without restoring anything (no "Continue where you left off", or a
 * declined "Restore pages?" bubble), and settles its startup window (about:blank) once it's open.
 */
async function relaunchWithoutRestore(dir: string) {
  const context = await launchWithExtension(dir);
  const sw = await serviceWorkerOf(context);
  await expect.poll(() => loadedTabUrls(sw)).toEqual([['about:blank']]);
  await settle(sw);
  expect((await readOutline(sw)).windows.some((w) => w.provisional)).toBe(false);
  return { context, sw };
}

/** Each record's state, by ID. */
async function states(sw: Worker, ids: string[]) {
  const { windows } = await readOutline(sw);
  return ids.map((id) => windows.find((w) => w.id === id)?.state);
}

for (const [how, stop] of [
  ['the browser is killed (out of memory)', (ctx: { dir: string }) => killChromium(ctx.dir)],
  [
    'the browser quits',
    (ctx: { dir: string; context: { close(): Promise<void> } }) => ctx.context.close(),
  ],
] as const) {
  test(`windows Chrome doesn't restore after ${how} stay as hibernated windows, not trash`, async () => {
    await withProfile(async (dir, pages) => {
      const first = await launchWithExtension(dir);
      let sw = await serviceWorkerOf(first);
      const a = await openWindow(sw, ['A1', 'A2'].map(pages.url));
      const b = await openWindow(sw, ['B1', 'B2', 'B3'].map(pages.url));
      const recA = await loadedRecord(sw, a, ['A1', 'A2']);
      const recB = await loadedRecord(sw, b, ['B1', 'B2', 'B3']);
      await outlineCommand(sw, { cmd: 'rename', windowId: recA.id, name: 'Work' });
      await expect.poll(async () => (await comeback(sw, recA.id)).name).toBe('Work');
      await stop({ dir, context: first });
      if (how.includes('killed')) await first.close().catch(() => undefined);

      const second = await relaunchWithoutRestore(dir);
      try {
        sw = second.sw;
        expect(await states(sw, [recA.id, recB.id])).toEqual(['hibernated', 'hibernated']);
        const back = await comeback(sw, recA.id);
        expect(back.name).toBe('Work');
        expect(back.tabs).toEqual(recA.tabs.map((t) => ({ id: t.id, live: false })));
        expect((await ownRecords(sw)).trashed).toBe(0);
      } finally {
        await second.context.close();
      }
    });
  });
}

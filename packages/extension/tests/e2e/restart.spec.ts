import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import {
  expect,
  launchWithExtension,
  outlineCommand,
  readOutline,
  relaunch,
  serviceWorkerOf,
  test,
} from './fixtures';

// These tests close and relaunch a real (headless) Chromium on one profile. A fresh launch is
// detected here through onInstalled('install') (--load-extension reinstalls on each launch);
// onStartup and chrome_update are covered by the browserSession unit tests.

// A restored window settles (1.5s of quiet) before it is matched, after Chrome has started and
// restored every tab: allow for that on top of the default.
const RESTORE_TIMEOUT = 15_000;

/**
 * A page server on 127.0.0.1: `/<name>` is a page titled `<name>`. Restored tabs load before
 * Playwright attaches to them, so `context.route` can't serve them; a real server can.
 */
async function startPageServer() {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url!, 'http://127.0.0.1').pathname.slice(1);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${name}</title>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: (name: string) => `${base}/${name}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type PageServer = Awaited<ReturnType<typeof startPageServer>>;

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
        .poll(async () => [await comeback(sw, recA.id), await comeback(sw, recB.id)], {
          timeout: RESTORE_TIMEOUT,
        })
        .toEqual([
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
        .poll(async () => comeback(sw, recD.id), { timeout: RESTORE_TIMEOUT })
        .toEqual({ state: 'live', name: undefined, tabs, groups: [], holders: 1 });
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

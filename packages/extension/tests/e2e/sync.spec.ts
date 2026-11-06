import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import type { SyncPickerState } from '../../src/shared/syncMessages';
import { createFakeDrive, type FakeDrive } from '../fakeDrive';
import {
  expect,
  launchWithExtension,
  outlineCommand,
  readOutline,
  runMenuAction,
  serviceWorkerOf,
  startPageServer,
  test,
  type PageServer,
} from './fixtures';

// Two Tab Hammer installs (two Chromium profiles) sync through one fake Drive served here, never
// Google: each service worker's sync engine is pointed at it through the useTestSync hook.

const TOKEN = 'test-token';
const VIEW_PATH = 'src/view/index.html';

interface Hooks {
  useTestSync: (o: { apiBase: string; token: string }) => Promise<void>;
  syncNow: () => Promise<void>;
  syncState: () => Promise<SyncPickerState>;
  openOrFocus: () => Promise<void>;
}
const hooks = (sw: Worker) =>
  ({
    useTestSync: (apiBase: string) =>
      sw.evaluate((o) => (globalThis as unknown as { tabHammer: Hooks }).tabHammer.useTestSync(o), {
        apiBase,
        token: TOKEN,
      }),
    syncNow: () =>
      sw.evaluate(() => (globalThis as unknown as { tabHammer: Hooks }).tabHammer.syncNow()),
    syncState: () =>
      sw.evaluate(() => (globalThis as unknown as { tabHammer: Hooks }).tabHammer.syncState()),
  }) as const;

/** The fake Drive over HTTP on 127.0.0.1. */
async function serveFakeDrive(): Promise<{
  drive: FakeDrive;
  base: string;
  close: () => Promise<void>;
}> {
  const drive = createFakeDrive({ tokens: [TOKEN] });
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const r = drive.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | undefined>,
        body,
      });
      res.writeHead(r.status, r.contentType ? { 'content-type': r.contentType } : {});
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    drive,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

interface Install {
  context: BrowserContext;
  sw: Worker;
  view: () => Promise<Page>;
}

/** A Tab Hammer install on its own temp profile, syncing with the fake Drive. */
async function launchInstall(dir: string, driveBase: string): Promise<Install> {
  const context = await launchWithExtension(dir);
  const sw = await serviceWorkerOf(context);
  await hooks(sw).useTestSync(driveBase);
  return {
    context,
    sw,
    view: async () => {
      const pagePromise = context.waitForEvent('page', (p) => p.url().includes(VIEW_PATH));
      await sw.evaluate(() =>
        (globalThis as unknown as { tabHammer: Hooks }).tabHammer.openOrFocus(),
      );
      const view = await pagePromise;
      await view.waitForLoadState();
      return view;
    },
  };
}

/** Two installs, A and B, a fake Drive, and a page server, torn down however `body` ends. */
async function withTwoInstalls(
  body: (a: Install, b: Install, drive: FakeDrive, pages: PageServer) => Promise<void>,
) {
  const dirs = await Promise.all(
    ['a', 'b'].map((n) => fs.mkdtemp(path.join(os.tmpdir(), `tab-hammer-sync-${n}-`))),
  );
  const fake = await serveFakeDrive();
  const pages = await startPageServer();
  const installs: Install[] = [];
  try {
    for (const dir of dirs) installs.push(await launchInstall(dir, fake.base));
    await body(installs[0]!, installs[1]!, fake.drive, pages);
  } finally {
    for (const i of installs) await i.context.close();
    await pages.close();
    await fake.close();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Opens a window of the page server's pages and waits for its live record, loaded. */
async function openLoadedWindow(
  sw: Worker,
  pages: PageServer,
  titles: string[],
): Promise<WindowRec> {
  const chromeId = await sw.evaluate(
    async (urls) => (await chrome.windows.create({ url: urls }))!.id!,
    titles.map((t) => pages.url(t)),
  );
  const find = async () =>
    (await readOutline(sw)).windows.find(
      (w) => w.state === 'live' && w.chromeWindowId === chromeId,
    );
  await expect.poll(async () => (await find())?.tabs.map((t) => t.title)).toEqual(titles);
  return (await find())!;
}

async function hibernatedWindow(sw: Worker, pages: PageServer, titles: string[]) {
  const rec = await openLoadedWindow(sw, pages, titles);
  await outlineCommand(sw, { cmd: 'hibernate', ids: [rec.id] });
  await expect
    .poll(async () => (await readOutline(sw)).windows.find((w) => w.id === rec.id)?.state)
    .toBe('hibernated');
  return rec;
}

async function pickComputer(view: Page, installId: string) {
  await runMenuAction(view, 'Other devices…');
  await view.locator(`[data-testid="picker-computer"][data-install-id="${installId}"]`).click();
  await expect(view.getByTestId('remote-banner')).toBeVisible();
}

test("A's hibernated window shows in B's picker, and Open here copies it live onto B", async () => {
  await withTwoInstalls(async (a, b, _drive, pages) => {
    const rec = await hibernatedWindow(a.sw, pages, ['Alpha', 'Bravo']);
    await hooks(a.sw).syncNow();
    const aId = (await hooks(a.sw).syncState()).self.installId;

    await hooks(b.sw).syncNow();
    const view = await b.view();
    await runMenuAction(view, 'Other devices…');
    const entry = view.locator(`[data-testid="picker-computer"][data-install-id="${aId}"]`);
    await expect(entry).toContainText('synced');
    await entry.click();
    const remoteWindow = view.locator(`[data-testid="remote-window"][data-row-id="${rec.id}"]`);
    await expect(remoteWindow.getByTestId('remote-tab')).toHaveText(['Alpha', 'Bravo']);
    await expect(view.getByTestId('remote-banner')).toContainText('read-only');

    await remoteWindow.locator('.window-header').dblclick();
    await expect(view.getByTestId('remote-banner')).toContainText('Opened on this computer');
    const urls = rec.tabs.map((t) => t.url);
    await expect
      .poll(async () => {
        const copy = (await readOutline(b.sw)).windows.find(
          (w) =>
            w.state === 'live' && JSON.stringify(w.tabs.map((t) => t.url)) === JSON.stringify(urls),
        );
        return (
          copy && {
            live: copy.tabs.every((t) => t.chromeTabId !== undefined),
            freshIds:
              copy.id !== rec.id && copy.tabs.every((t) => !rec.tabs.some((r) => r.id === t.id)),
          }
        );
      })
      .toEqual({ live: true, freshIds: true });
    // A's own record is untouched: Open here copies.
    expect((await readOutline(a.sw)).windows.find((w) => w.id === rec.id)?.state).toBe(
      'hibernated',
    );
  });
});

test("Restore all brings A's windows into B, hibernated, and Retire drops A's file", async () => {
  await withTwoInstalls(async (a, b, drive, pages) => {
    const one = await hibernatedWindow(a.sw, pages, ['One']);
    const two = await openLoadedWindow(a.sw, pages, ['Two', 'Three']); // live on A
    await hooks(a.sw).syncNow();
    const aId = (await hooks(a.sw).syncState()).self.installId;

    await hooks(b.sw).syncNow();
    const view = await b.view();
    await pickComputer(view, aId);
    await view.getByRole('button', { name: 'Restore all' }).click();
    await expect(view.getByTestId('remote-banner')).toContainText('Restored');

    await expect
      .poll(async () => {
        const { windows } = await readOutline(b.sw);
        return [one.id, two.id].map((id) => {
          const w = windows.find((x) => x.id === id);
          return w && { state: w.state, titles: w.tabs.map((t) => t.title) };
        });
      })
      .toEqual([
        { state: 'hibernated', titles: ['One'] },
        { state: 'hibernated', titles: ['Two', 'Three'] },
      ]);

    await view.getByRole('button', { name: 'Retire' }).click();
    await expect(view.getByTestId('remote-banner')).toBeHidden();
    expect([...drive.byName().keys()].some((n) => n.includes(aId))).toBe(false);
    // B's own outline is shown again, with the restored windows in it, dimmed.
    await expect(view.locator(`.window-header.hibernated[data-key="w:${one.id}"]`)).toBeVisible();
  });
});

test('a checkpoint view restores windows deleted since', async () => {
  await withTwoInstalls(async (a, _b, _drive, pages) => {
    const w1 = await hibernatedWindow(a.sw, pages, ['Keep1']);
    const w2 = await hibernatedWindow(a.sw, pages, ['Keep2']);
    await hooks(a.sw).syncNow();

    // Delete both for good: a push that drops most windows checkpoints the last pushed outline.
    for (const id of [w1.id, w2.id]) {
      await outlineCommand(a.sw, { cmd: 'trash', ids: [id] });
      await outlineCommand(a.sw, { cmd: 'deleteForever', windowId: id });
    }
    await hooks(a.sw).syncNow();
    expect((await readOutline(a.sw)).windows.some((w) => w.id === w1.id || w.id === w2.id)).toBe(
      false,
    );

    const view = await a.view();
    await runMenuAction(view, 'Other devices…');
    await view.getByTestId('picker-checkpoints').click();
    await view
      .getByTestId('picker-checkpoint')
      .filter({ hasText: 'before a big change' })
      .first()
      .click();
    await expect(view.getByTestId('remote-banner')).toContainText('Checkpoint of');
    await expect(view.getByTestId('remote-tab')).toContainText(['Keep1', 'Keep2']);
    await view.getByRole('button', { name: 'Restore all' }).click();
    await expect(view.getByTestId('remote-banner')).toContainText('Restored 2 windows');

    await expect
      .poll(async () =>
        (await readOutline(a.sw)).windows
          .filter((w) => w.id === w1.id || w.id === w2.id)
          .map((w) => [w.state, w.tabs.map((t) => t.title)]),
      )
      .toEqual([
        ['hibernated', ['Keep1']],
        ['hibernated', ['Keep2']],
      ]);
  });
});

test('a wiped profile restores its own file, re-linking the windows Chrome has open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-hammer-sync-self-'));
  const fake = await serveFakeDrive();
  const pages = await startPageServer();
  const context = await launchWithExtension(dir);
  try {
    const sw = await serviceWorkerOf(context);
    // The window Chrome has open (restored, say) on a profile whose outline database is new.
    const open = await openLoadedWindow(sw, pages, ['Red', 'Green']);
    const installId = (await hooks(sw).syncState()).self.installId;
    // This install's own file in Drive, from before the wipe.
    const tab = (id: string, url: string) => ({ id, url, title: id, modifiedAt: 1 });
    const win = (id: string, state: string, tabs: unknown[]) => ({
      id,
      state,
      lastLiveAt: 1,
      originInstallId: installId,
      modifiedAt: 1,
      tabs,
      groups: [],
    });
    fake.drive.put(
      `outline-${installId}.json`,
      JSON.stringify({
        schemaVersion: 1,
        installId,
        computerName: 'Desk',
        platform: 'mac',
        updatedAt: 1,
        windows: [
          {
            ...win('saved', 'live', [
              tab('s-red', pages.url('Red')),
              tab('s-green', pages.url('Green')),
            ]),
            name: 'Colours',
          },
          win('put-away', 'hibernated', [tab('p-blue', pages.url('Blue'))]),
        ],
      }),
    );

    await hooks(sw).useTestSync(fake.base);

    await expect
      .poll(async () => {
        const { windows } = await readOutline(sw);
        const saved = windows.find((w) => w.id === 'saved');
        return {
          saved: saved && {
            state: saved.state,
            name: saved.name,
            chromeWindowId: saved.chromeWindowId,
            tabs: saved.tabs.map((t) => [t.id, t.chromeTabId !== undefined]),
          },
          holders: windows.filter((w) => w.chromeWindowId === open.chromeWindowId).length,
          freshRecordGone: !windows.some((w) => w.id === open.id),
          putAway: windows.find((w) => w.id === 'put-away')?.state,
        };
      })
      .toEqual({
        saved: {
          state: 'live',
          name: 'Colours',
          chromeWindowId: open.chromeWindowId,
          tabs: [
            ['s-red', true],
            ['s-green', true],
          ],
        },
        holders: 1,
        freshRecordGone: true,
        putAway: 'hibernated',
      });
  } finally {
    await context.close();
    await pages.close();
    await fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

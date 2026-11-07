import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { WindowRec } from '../../src/model/outline/types';
import type { OutlineCommand } from '../../src/shared/outlineMessages';

// Built by `npm run build:e2e`. Kept apart from ~/.tab-hammer/dist, which the user's dev server
// writes and their own Chrome loads, so gate runs never clobber it.
const DIST = path.resolve(import.meta.dirname, '../../dist-e2e');
const VIEW_PATH = 'src/view/index.html';

type Fixtures = { context: BrowserContext; sw: Worker; view: Page; pages: PageServer };

/**
 * Launches Chromium with the built extension. channel 'chromium' = full Chromium in new headless
 * mode, which supports extensions (the default headless shell does not). The default '' user-data
 * dir makes a throwaway profile; pass a real one to put files in it first (e.g. a native host).
 */
export function launchWithExtension(
  userDataDir = '',
  env?: Record<string, string>,
  extra: { args?: string[]; ignoreDefaultArgs?: string[] } = {},
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      ...(extra.args ?? []),
    ],
    ...(extra.ignoreDefaultArgs && { ignoreDefaultArgs: extra.ignoreDefaultArgs }),
    ...(env && { env: { ...(process.env as Record<string, string>), ...env } }),
  });
}

/** The extension's service worker in this context, waiting for it to start if it hasn't. */
export async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/**
 * Relaunches Chromium on a profile a previous launch closed, restoring that session's windows the
 * way Chrome does after a restart. `--restore-last-session` is what restores them (the profile's
 * "continue where you left off" pref alone doesn't in headless Chromium), and dropping
 * Playwright's own `about:blank` startup URL keeps Chrome from adding it as a tab to a restored
 * window.
 */
export async function relaunch(
  userDataDir: string,
): Promise<{ context: BrowserContext; sw: Worker }> {
  const context = await launchWithExtension(userDataDir, undefined, {
    args: ['--restore-last-session'],
    ignoreDefaultArgs: ['about:blank'],
  });
  return { context, sw: await serviceWorkerOf(context) };
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await launchWithExtension();
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    await use(await serviceWorkerOf(context));
  },
  view: async ({ context, sw }, use) => {
    // Open the view exactly as the toolbar click does, then attach to that page.
    const pagePromise = context.waitForEvent('page', (p) => p.url().includes(VIEW_PATH));
    await sw.evaluate(() =>
      (
        globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
      ).tabHammer.openOrFocus(),
    );
    const view = await pagePromise;
    await view.waitForLoadState();
    await use(view);
  },
  // eslint-disable-next-line no-empty-pattern
  pages: async ({}, use) => {
    const pages = await startPageServer();
    await use(pages);
    await pages.close();
  },
});

/** The service worker's in-memory outline (Chrome IDs included), once its queued work is done. */
export function readOutline(sw: Worker): Promise<{ schemaVersion: number; windows: WindowRec[] }> {
  return sw.evaluate(() =>
    (
      globalThis as unknown as {
        tabHammer: { readOutline: () => Promise<{ schemaVersion: number; windows: WindowRec[] }> };
      }
    ).tabHammer.readOutline(),
  );
}

/**
 * Matches the windows waiting to be re-linked (restored, or opened by the test) now, as their quiet
 * period would. The e2e build has no quiet period, so this is the only way they settle: call it
 * once Chrome has finished opening them.
 */
export function settle(sw: Worker): Promise<void> {
  return sw.evaluate(() =>
    (globalThis as unknown as { tabHammer: { settle: () => Promise<void> } }).tabHammer.settle(),
  );
}

/** The URLs of every loaded tab in Chrome's normal windows, window by window, in tab order. */
export function loadedTabUrls(sw: Worker): Promise<string[][]> {
  return sw.evaluate(async () =>
    (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }))
      .map((w) => (w.tabs ?? []).filter((t) => t.status === 'complete').map((t) => t.url ?? ''))
      .sort(),
  );
}

type Shape = {
  tabs: [id: number, title: string][];
  groups: [id: number, title: string][];
  /** Every tab row's key in order, hibernated ones included (outline and view only). */
  rows?: string[];
}[];

/** Chrome's normal windows by ID: each one's tabs and groups in tab order, as the view titles them. */
function chromeShape(sw: Worker): Promise<{ loading: boolean; windows: Record<number, Shape[0]> }> {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title ?? '']));
    const windows: Record<number, Shape[0]> = {};
    for (const t of tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
      const w = (windows[t.windowId] ??= { tabs: [], groups: [] });
      w.tabs.push([t.id!, t.title || t.url || '']);
      if (t.groupId !== -1 && !w.groups.some(([id]) => id === t.groupId))
        w.groups.push([t.groupId, groups.get(t.groupId) || 'Untitled group']);
    }
    return { loading: tabs.some((t) => t.status !== 'complete'), windows };
  });
}

/** The outline's live windows by Chrome ID, shaped like chromeShape, plus their rows. */
async function outlineShape(sw: Worker): Promise<Record<number, Shape[0]>> {
  const windows: Record<number, Shape[0]> = {};
  for (const w of (await readOutline(sw)).windows) {
    if (w.state !== 'live' || w.chromeWindowId === undefined) continue;
    const live = w.tabs.filter((t) => t.chromeTabId !== undefined);
    windows[w.chromeWindowId] = {
      tabs: live.map((t) => [t.chromeTabId!, t.title || t.url]),
      groups: w.groups
        .filter((g) => g.chromeGroupId !== undefined && live.some((t) => t.groupId === g.id))
        .sort(
          (a, b) =>
            live.findIndex((t) => t.groupId === a.id) - live.findIndex((t) => t.groupId === b.id),
        )
        .map((g) => [g.chromeGroupId!, g.title || 'Untitled group']),
      rows: w.tabs.map((t) => `t:${t.id}`),
    };
  }
  return windows;
}

const withoutRows = (shape: Record<number, Shape[0]>) =>
  Object.fromEntries(Object.entries(shape).map(([id, { tabs, groups }]) => [id, { tabs, groups }]));

/** What the view renders for each live window: its tab and group rows, in order. */
function viewShape(view: Page): Promise<Record<number, Shape[0]>> {
  return view.evaluate(() => {
    const windows: Record<number, Shape[0]> = {};
    for (const header of document.querySelectorAll<HTMLElement>('[data-window-id]')) {
      const card = header.parentElement!;
      windows[Number(header.dataset.windowId)] = {
        tabs: [...card.querySelectorAll<HTMLElement>('[data-tab-id]')].map((r) => [
          Number(r.dataset.tabId),
          r.querySelector('.title')?.textContent ?? '',
        ]),
        groups: [...card.querySelectorAll<HTMLElement>('[data-group-id]')].map((r) => [
          Number(r.dataset.groupId),
          r.querySelector('.title')?.textContent ?? '',
        ]),
        rows: [...card.querySelectorAll<HTMLElement>('[data-kind="tab"]')].map(
          (r) => r.dataset.key ?? '',
        ),
      };
    }
    return windows;
  });
}

/**
 * Waits until what a test built in Chrome has fully arrived: every tab loaded, the worker's outline
 * holding exactly Chrome's tabs, titles and groups, and (given a view) the view showing them. Call
 * it after building a layout and before pointing at rows, so a late update (a title loading, a
 * group row appearing) can't move a row under the pointer. Expects every live window expanded.
 */
export async function synced(sw: Worker, view?: Page): Promise<void> {
  await expect.poll(async () => (await chromeShape(sw)).loading).toBe(false);
  const { windows } = await chromeShape(sw);
  await expect.poll(async () => withoutRows(await outlineShape(sw))).toEqual(windows);
  if (view) {
    const outline = await outlineShape(sw);
    await expect.poll(() => viewShape(view)).toEqual(outline);
  }
}

/** Runs an outline command in the service worker, as the view's runtime message would. */
export function outlineCommand(sw: Worker, c: OutlineCommand): Promise<void> {
  return sw.evaluate(
    (cmd) =>
      (
        globalThis as unknown as {
          tabHammer: { outlineCommand: (c: OutlineCommand) => Promise<void> };
        }
      ).tabHammer.outlineCommand(cmd),
    c,
  );
}

/** The outline row of a live Chrome window, group, or tab, found by its Chrome ID. */
export function liveRow(view: Page, kind: 'window' | 'group' | 'tab', chromeId: number) {
  return view.locator(`[data-${kind}-id="${chromeId}"]`);
}

/** Picks an action from the header's Actions menu (Capture missing, Clear previews, …). */
export async function runMenuAction(view: Page, label: string | RegExp) {
  await view.getByRole('button', { name: 'Actions' }).click();
  await view.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: label }).click();
}

/**
 * A page server on 127.0.0.1: `/<name>` is a page titled `<name>`. Tabs Chrome opens itself (restored
 * after a restart, or reopened by the service worker) load before Playwright attaches to them, so
 * `context.route` can't serve them; a real server can.
 */
export async function startPageServer() {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url!, 'http://127.0.0.1').pathname.slice(1);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${name}</title>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: (name: string) => `${base}/${name}`,
    // Chromium keeps connections alive; a close that waited on them would outlast the test.
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type PageServer = Awaited<ReturnType<typeof startPageServer>>;

export { expect };

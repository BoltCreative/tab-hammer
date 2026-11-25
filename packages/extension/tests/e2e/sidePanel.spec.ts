import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import {
  expect,
  launchWithExtension,
  loadedTabUrls,
  readOutline,
  relaunch,
  runMenuAction,
  serviceWorkerOf,
  settle,
  startPageServer,
  test,
} from './fixtures';

// Docked mode. Headless Chromium runs real side panels (each one's page connects to the worker),
// but Playwright can't reach a side panel's page, so a panel's own clicks are driven on panel.html
// opened as an ordinary tab: the same page, which only skips telling the worker it's a panel.

const PANEL_PATH = 'src/view/panel.html';

/** Browser windows whose docked panel has connected to the worker. */
function panelWindows(sw: Worker): Promise<number[]> {
  return sw.evaluate(() =>
    (
      globalThis as unknown as { tabHammer: { panelWindows: () => number[] } }
    ).tabHammer.panelWindows(),
  );
}

function normalWindowIds(sw: Worker): Promise<number[]> {
  return sw.evaluate(async () =>
    (await chrome.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id!).sort(),
  );
}

function stored(sw: Worker) {
  return sw.evaluate(async () => ({
    mode: (await chrome.storage.local.get('viewMode')).viewMode as unknown,
    toolbarOpensPanel: (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick,
  }));
}

function popupCount(sw: Worker): Promise<number> {
  return sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['popup'] })).length);
}

async function openWindows(sw: Worker, n: number): Promise<void> {
  await sw.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await chrome.windows.create({ url: 'about:blank' });
  }, n);
}

/** Clicks the standalone window's Dock button and waits for the window to close. */
async function dock(view: Page): Promise<void> {
  const closed = view.waitForEvent('close');
  await view.getByRole('button', { name: 'Dock in the side panel' }).click();
  await closed;
}

/** panel.html as an ordinary tab: the docked view's page, reachable by Playwright. */
async function openPanelPage(context: BrowserContext, sw: Worker): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/${PANEL_PATH}`);
  await expect(page.locator('main.outline')).toBeVisible();
  return page;
}

test('Dock opens the side panel in every browser window and closes the standalone window', async ({
  sw,
  view,
}) => {
  await openWindows(sw, 2);
  // Nothing stored yet: docked is the default, which the worker applies to the toolbar on start.
  await expect.poll(() => stored(sw)).toEqual({ mode: undefined, toolbarOpensPanel: true });

  await dock(view);

  const windows = await normalWindowIds(sw);
  expect(windows.length).toBeGreaterThanOrEqual(3);
  await expect.poll(() => panelWindows(sw)).toEqual(windows);
  expect(await stored(sw)).toEqual({ mode: 'dock', toolbarOpensPanel: true });
  expect(await popupCount(sw)).toBe(0);
});

test('a click in a docked panel opens it in windows opened since, not where the user closed it', async ({
  context,
  sw,
  view,
}) => {
  await openWindows(sw, 1);
  await dock(view);
  const [closedByUser] = await normalWindowIds(sw);
  await expect.poll(async () => (await panelWindows(sw)).length).toBe(2);

  // The user closes one window's panel, then opens a new window, which has none.
  await sw.evaluate((windowId) => chrome.sidePanel.close({ windowId }), closedByUser!);
  await expect.poll(() => panelWindows(sw)).not.toContain(closedByUser);
  await openWindows(sw, 1);

  // A click anywhere in a panel opens the missing ones (the panel page's own tab is in a window
  // that has none either).
  const panel = await openPanelPage(context, sw);
  await panel.locator('main.outline').click({ position: { x: 5, y: 5 } });

  const expected = (await normalWindowIds(sw)).filter((id) => id !== closedByUser);
  await expect.poll(() => panelWindows(sw)).toEqual(expected);
});

/** What the worker answers a click in a panel: the windows that should get a panel now. */
function missingPanels(panel: Page): Promise<number[]> {
  return panel.evaluate(
    async () =>
      (
        (await chrome.runtime.sendMessage({ type: 'tabHammer.missingPanels' })) as {
          windowIds: number[];
        }
      ).windowIds,
  );
}

/** The Actions menu's "Open in every window" setting in a docked panel's page. */
async function openInEveryWindow(panel: Page) {
  await panel.getByRole('button', { name: 'Actions' }).click();
  return panel
    .getByRole('menu', { name: 'Actions' })
    .getByRole('menuitemcheckbox', { name: 'Open in every window' });
}

test('with the panel set to open only where the user opens it, a click in a panel opens it nowhere else', async ({
  context,
  sw,
  view,
}) => {
  await dock(view);
  await expect.poll(async () => (await panelWindows(sw)).length).toBe(1);
  const panel = await openPanelPage(context, sw);

  // On by default; turning it off is remembered.
  const setting = await openInEveryWindow(panel);
  await expect(setting).toHaveAttribute('aria-checked', 'true');
  await setting.click();
  await expect
    .poll(() =>
      sw.evaluate(async () => (await chrome.storage.local.get('panelOpensIn')).panelOpensIn),
    )
    .toBe('here');
  await expect(await openInEveryWindow(panel)).toHaveAttribute('aria-checked', 'false');
  await panel.keyboard.press('Escape');
  // Windows opened since have no panel, and a click asks for none.
  await openWindows(sw, 1);
  const showing = await panelWindows(sw);
  const without = (await normalWindowIds(sw)).filter((id) => !showing.includes(id));
  expect(without.length).toBeGreaterThan(0);
  expect(await missingPanels(panel)).toEqual([]);

  // Back on, the next click in the panel opens it in them (the menu pick itself may already have:
  // its press reaches the worker around the moment the setting changes).
  await (await openInEveryWindow(panel)).click();
  await expect
    .poll(() =>
      sw.evaluate(async () => (await chrome.storage.local.get('panelOpensIn')).panelOpensIn),
    )
    .toBe('every');
  await panel.locator('main.outline').click({ position: { x: 5, y: 5 } });
  await expect.poll(() => panelWindows(sw)).toEqual(await normalWindowIds(sw));
});

test('a window the user closed the panel in stays without it after a browser restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-hammer-declined-'));
  const pages = await startPageServer();
  try {
    const first = await launchWithExtension(dir);
    let sw = await serviceWorkerOf(first);
    const [a, b] = await sw.evaluate(
      async (urls) =>
        Promise.all(urls.map(async (url) => (await chrome.windows.create({ url }))!.id!)),
      [pages.url('A'), pages.url('B')],
    );
    const pagePromise = first.waitForEvent('page', (p) => p.url().includes('src/view/index.html'));
    await sw.evaluate(() =>
      (
        globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
      ).tabHammer.openOrFocus(),
    );
    await dock(await pagePromise);
    await expect.poll(() => panelWindows(sw)).toEqual(await normalWindowIds(sw));

    // The user closes A's panel: remembered by A's Tab Hammer ID, not Chrome's window ID.
    await sw.evaluate((windowId) => chrome.sidePanel.close({ windowId }), a!);
    const recordOf = async (title: string) =>
      (await readOutline(sw)).windows.find((w) => w.tabs.some((t) => t.title === title))?.id;
    const recA = await recordOf('A');
    const recB = await recordOf('B');
    expect(recA).toBeDefined();
    const declined = () =>
      sw.evaluate(async () => (await chrome.storage.local.get('dockDeclined')).dockDeclined);
    await expect.poll(declined).toEqual([recA]);
    expect(b).toBeDefined();
    await first.close();

    const second = await relaunch(dir);
    try {
      sw = second.sw;
      await expect
        .poll(() => loadedTabUrls(sw))
        .toEqual(expect.arrayContaining([[pages.url('A')], [pages.url('B')]]));
      await settle(sw);
      expect(await recordOf('A')).toBe(recA);
      expect(await recordOf('B')).toBe(recB);
      expect(await declined()).toEqual([recA]);
      const chromeIdOf = async (id: string | undefined) =>
        (await readOutline(sw)).windows.find((w) => w.id === id)!.chromeWindowId!;
      const newA = await chromeIdOf(recA);
      const newB = await chromeIdOf(recB);

      // A click in a panel opens it everywhere it's missing except A.
      const panel = await openPanelPage(second.context, sw);
      const missing = await missingPanels(panel);
      expect(missing).not.toContain(newA);
      expect([...missing, ...(await panelWindows(sw))]).toContain(newB);
    } finally {
      await second.context.close();
    }
  } finally {
    await pages.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Pop out reopens the standalone window and closes every panel', async ({
  context,
  sw,
  view,
}) => {
  await dock(view);
  await expect.poll(async () => (await panelWindows(sw)).length).toBe(1);

  const panel = await openPanelPage(context, sw);
  const standalone = context.waitForEvent('page', (p) => p.url().includes('src/view/index.html'));
  await panel.getByRole('button', { name: 'Pop out to a window' }).click();
  const reopened = await standalone;
  await expect(reopened.locator('main.outline')).toBeVisible();

  await expect.poll(() => panelWindows(sw)).toEqual([]);
  expect(await stored(sw)).toEqual({ mode: 'float', toolbarOpensPanel: false });
  expect(await popupCount(sw)).toBe(1);
});

test('docked mode survives a browser restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-hammer-dock-'));
  try {
    const first = await launchWithExtension(dir);
    const sw = await serviceWorkerOf(first);
    const pagePromise = first.waitForEvent('page', (p) => p.url().includes('src/view/index.html'));
    await sw.evaluate(() =>
      (
        globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
      ).tabHammer.openOrFocus(),
    );
    const view = await pagePromise;
    await expect(view.locator('main.outline')).toBeVisible();
    await dock(view);
    expect(await stored(sw)).toEqual({ mode: 'dock', toolbarOpensPanel: true });
    await first.close();

    const { context, sw: sw2 } = await relaunch(dir);
    try {
      expect(await stored(sw2)).toEqual({ mode: 'dock', toolbarOpensPanel: true });
    } finally {
      await context.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the docked layout fits Chrome’s narrowest side panel', async ({ context, sw }) => {
  const panel = await openPanelPage(context, sw);
  await panel.setViewportSize({ width: 360, height: 700 });

  // Nothing overflows sideways, and the header's controls and the preview panel stay on screen.
  expect(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  for (const name of ['Pop out to a window', 'Actions']) {
    const box = (await panel.getByRole('button', { name }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  await expect(panel.locator('.preview-panel')).toBeInViewport();

  // Chrome's default side is the right, so the panel's border is on its left, facing the page.
  await expect(panel.locator('html')).toHaveAttribute('data-side', 'right');

  // With Chrome's side panel on the left (stubbed: headless can't change the setting), the border
  // moves to the panel's right.
  await panel.evaluate(() => {
    chrome.sidePanel.getLayout = (() =>
      Promise.resolve({ side: 'left' })) as typeof chrome.sidePanel.getLayout;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(panel.locator('html')).toHaveAttribute('data-side', 'left');
});

test('a docked panel’s Panel side… opens Chrome’s side panel setting', async ({
  context,
  sw,
  view,
}) => {
  // The standalone window has no panel side to set.
  await view.getByRole('button', { name: 'Actions' }).click();
  await expect(view.getByRole('menuitem', { name: 'Panel side…' })).toHaveCount(0);
  await view.keyboard.press('Escape');

  const panel = await openPanelPage(context, sw);
  await runMenuAction(panel, 'Panel side…');
  await expect
    .poll(() =>
      sw.evaluate(async () =>
        (await chrome.tabs.query({})).some((t) =>
          (t.url || t.pendingUrl || '').startsWith('chrome://settings/appearance'),
        ),
      ),
    )
    .toBe(true);
});

test('a docked panel opens scrolled to the window it sits in, and marks it', async ({
  context,
  sw,
}) => {
  // Enough windows that the list scrolls; the panel's page then opens in an early one (not the
  // first), with plenty after it so it can scroll to the top.
  await openWindows(sw, 20);
  const hostId = (await normalWindowIds(sw))[3]!;
  const pagePromise = context.waitForEvent('page', (p) => p.url().includes(PANEL_PATH));
  await sw.evaluate(
    async ({ windowId, url }) => void (await chrome.tabs.create({ windowId, url })),
    { windowId: hostId, url: `chrome-extension://${new URL(sw.url()).host}/${PANEL_PATH}` },
  );
  const panel = await pagePromise;

  const host = panel.locator(`[data-kind="window"][data-window-id="${hostId}"]`);
  await expect(host).toHaveAttribute('aria-current', 'location');
  await expect(panel.locator('[data-kind="window"][aria-current]')).toHaveCount(1);
  // The outline's order is unchanged: the host isn't moved to the front.
  await expect(panel.locator('[data-kind="window"]').first()).not.toHaveAttribute(
    'data-window-id',
    String(hostId),
  );
  // It's scrolled to the window's current tab (the panel page's own tab here): that row sits in
  // the middle of the list, or as near as the list's top allows, clear of the sticky window bar.
  const activeId = await sw.evaluate(
    async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0]!.id!,
    hostId,
  );
  const row = panel.locator(`[data-tab-id="${activeId}"]`);
  await expect(row).toHaveAttribute('data-cursor', 'true');
  const list = panel.locator('main.outline');
  await expect
    .poll(async () => {
      const l = (await list.boundingBox())!;
      const r = (await row.boundingBox())!;
      return r.y >= l.y + 22 && r.y + r.height <= l.y + l.height;
    })
    .toBe(true);
});

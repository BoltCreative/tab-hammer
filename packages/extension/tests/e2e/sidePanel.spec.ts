import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, launchWithExtension, relaunch, serviceWorkerOf, test } from './fixtures';

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
  expect(await stored(sw)).toEqual({ mode: undefined, toolbarOpensPanel: false });

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

  // Chrome's default side is the right, so there's no hint; the panel's left edge faces the page.
  await expect(panel.getByTestId('side-hint')).toHaveCount(0);
  await expect(panel.locator('html')).toHaveAttribute('data-side', 'right');

  // With Chrome's side panel on the left (stubbed: headless can't change the setting), a one-line
  // hint says how to move it.
  await panel.evaluate(() => {
    chrome.sidePanel.getLayout = (() =>
      Promise.resolve({ side: 'left' })) as typeof chrome.sidePanel.getLayout;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(panel.getByTestId('side-hint')).toBeVisible();
  await expect(panel.locator('html')).toHaveAttribute('data-side', 'left');
});

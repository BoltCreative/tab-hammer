import type { BrowserContext, Worker } from '@playwright/test';
import type { TestHooks } from '../../src/background/index';
import { expect, liveRow, outlineCommand, readOutline, runMenuAction, test } from './fixtures';

// Chrome refuses to capture data: pages, so serve real http pages from Playwright instead.
const ORIGIN = 'http://tabhammer.test';
async function servePages(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({
      contentType: 'text/html',
      body: `<title>${name}</title><body style="background:#c33;color:#fff">${name}</body>`,
    });
  });
}

/**
 * Opens a window (showing about:blank) with these pages in background tabs, and returns the tabs'
 * IDs. A tab's requests are only routed once Playwright has attached to it, and a tab the service
 * worker creates starts loading before that (unrouted, it would load Chrome's error page), so each
 * tab starts on a placeholder and navigates once Playwright has seen it.
 */
async function openBackgroundTabs(
  context: BrowserContext,
  sw: Worker,
  urls: string[],
): Promise<number[]> {
  const placeholders = urls.map((_, i) => `about:blank#tab${i}`);
  const ids = await sw.evaluate(async (placeholders) => {
    const win = await chrome.windows.create({ url: 'about:blank' });
    const ids: number[] = [];
    for (const url of placeholders)
      ids.push((await chrome.tabs.create({ windowId: win!.id!, url, active: false })).id!);
    return ids;
  }, placeholders);
  await expect
    .poll(() => context.pages().map((p) => p.url()))
    .toEqual(expect.arrayContaining(placeholders));
  await sw.evaluate(
    ({ ids, urls }) => Promise.all(ids.map((id, i) => chrome.tabs.update(id, { url: urls[i] }))),
    { ids, urls },
  );
  return ids;
}

const tabInfo = (sw: Worker, tabId: number) =>
  sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    return { title: t.title, status: t.status, active: t.active };
  }, tabId);

const hasPreview = (sw: Worker, url: string) =>
  sw.evaluate(
    (u) => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.hasPreview(u),
    url,
  );

test('hovering a tab shows its captured preview in the panel; an uncapturable page gets text only', async ({
  context,
  sw,
  view,
}) => {
  await servePages(context);
  const shotUrl = `${ORIGIN}/shot`;
  // A new window's only tab is its visible tab, so the service worker captures it once it loads.
  const ids = await sw.evaluate(async (url) => {
    const win = await chrome.windows.create({ url });
    return { windowId: win!.id!, tabId: win!.tabs![0]!.id! };
  }, shotUrl);
  await expect.poll(() => hasPreview(sw, shotUrl)).toBe(true);
  // The service worker records each attempt's outcome after saving; the panel reads it below.
  await expect
    .poll(() =>
      sw.evaluate(async (windowId) => {
        const { captureOutcomes } = await chrome.storage.session.get('captureOutcomes');
        return (captureOutcomes as Record<string, { outcome: string }> | undefined)?.[windowId]
          ?.outcome;
      }, ids.windowId),
    )
    .toBe('saved');

  // Two background tabs: one on the same page (previews are keyed by URL, fragment ignored, so it
  // shares the shot) and one on a page Chrome won't let extensions capture.
  const [twinId, neverId] = await sw.evaluate(
    async ({ windowId, twin, never }) => {
      const a = await chrome.tabs.create({ windowId, url: twin, active: false });
      const b = await chrome.tabs.create({ windowId, url: never, active: false });
      return [a.id!, b.id!];
    },
    { windowId: ids.windowId, twin: `${shotUrl}#section`, never: 'about:blank' },
  );

  const panel = view.getByTestId('preview-panel');
  const shot = panel.locator('.preview-shot');
  const row = (tabId: number) => liveRow(view, 'tab', tabId);
  const expectShot = async () => {
    await expect(shot).toHaveJSProperty('complete', true);
    expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  };

  await expect(panel).toContainText('Hover over a tab');
  await row(ids.tabId).hover();
  await expectShot();
  await expect(panel).toContainText(shotUrl);
  await expect(panel).toContainText('Last viewed');

  await row(twinId).hover();
  await expect(panel).toContainText(`${shotUrl}#section`);
  await expectShot();

  await row(neverId).hover();
  await expect(panel).toContainText('about:blank');
  await expect(shot).toHaveCount(0);
  // A tab without a preview says what the window's latest capture attempt did (in friendly text,
  // not the raw outcome code), and gets a muted favicon placeholder instead of a screenshot in the
  // preview area.
  await expect(panel).toContainText('A preview was captured but isn’t available for this page');
  await expect(panel.locator('.preview-image-favicon')).toBeVisible();

  // Moving off the outline keeps the last hovered tab rather than going blank.
  await view.getByRole('combobox').hover();
  await expect(panel).toContainText('about:blank');
  await expect(panel).not.toContainText('Hover over a tab');

  // Selecting a tab with the keyboard shows it; the panel never gets in the way of selection.
  await row(neverId).click();
  await expect(row(neverId)).toHaveAttribute('aria-selected', 'true');
  await view.keyboard.press('ArrowUp');
  await expect(row(twinId)).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toContainText(`${shotUrl}#section`);

  // The panel follows the shown tab live: here it navigates.
  await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://tabhammer.test/moved' }), twinId);
  await expect(panel).toContainText('http://tabhammer.test/moved');
});

test('hovering a background tab never attaches the debugger (its infobar would shift the list)', async ({
  context,
  sw,
  view,
}) => {
  await servePages(context);
  const hiddenUrl = `${ORIGIN}/hidden`;
  const [tabId] = (await openBackgroundTabs(context, sw, [hiddenUrl])) as [number];
  await expect
    .poll(() => tabInfo(sw, tabId))
    .toEqual({
      title: 'hidden',
      status: 'complete',
      active: false,
    });
  // Count every debugger attach the service worker makes from here on.
  await sw.evaluate(() => {
    const g = globalThis as unknown as { attaches: number };
    g.attaches = 0;
    const original = chrome.debugger.attach.bind(chrome.debugger);
    chrome.debugger.attach = ((...args: Parameters<typeof original>) => {
      g.attaches++;
      return original(...args);
    }) as typeof chrome.debugger.attach;
  });
  const attaches = () =>
    sw.evaluate(() => (globalThis as unknown as { attaches: number }).attaches);

  await liveRow(view, 'tab', tabId).hover();
  const panel = view.getByTestId('preview-panel');
  await expect(panel).toContainText(hiddenUrl);
  await expect(panel).toContainText('Capture missing');
  await expect(panel).not.toContainText('Capturing');
  expect(await attaches()).toBe(0);
  expect(await hasPreview(sw, hiddenUrl)).toBe(false);

  // The explicit Refresh run is what captures it, through the debugger.
  await runMenuAction(view, 'Capture missing');
  await expect(view.getByRole('status')).toHaveText(/^refreshed \d+\/\d+ pages/);
  expect(await hasPreview(sw, hiddenUrl)).toBe(true);
  expect(await attaches()).toBeGreaterThan(0);
  expect((await tabInfo(sw, tabId)).active).toBe(false);
});

test('the preview panel sits below the outline; its collapse and height survive a reopen', async ({
  context,
  sw,
  view,
}) => {
  // Enough tabs that the outline scrolls.
  const tabIds = await sw.evaluate(async () => {
    const win = await chrome.windows.create({ url: 'about:blank#0' });
    const ids = [win!.tabs![0]!.id!];
    for (let i = 1; i < 40; i++)
      ids.push((await chrome.tabs.create({ windowId: win!.id!, url: `about:blank#${i}` })).id!);
    return ids;
  });
  const lastRow = liveRow(view, 'tab', tabIds.at(-1)!);
  await expect(lastRow).toBeVisible();
  let panel = view.getByTestId('preview-panel');
  const toggle = (p = view) => p.getByRole('button', { name: 'Preview' });
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true');

  // The outline ends where the panel starts: scrolled to the bottom, the last row is above it.
  const outlineBottom = async () => {
    const box = (await view.locator('main.outline').boundingBox())!;
    return box.y + box.height;
  };
  const panelTop = async () => (await panel.boundingBox())!.y;
  expect(await outlineBottom()).toBeLessThanOrEqual(await panelTop());
  await view.locator('main.outline').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const rowBox = (await lastRow.boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(await panelTop());

  // Dragging the top edge up makes the panel taller, and the outline shorter by as much.
  const before = (await panel.boundingBox())!.height;
  const outlineBefore = await outlineBottom();
  const edge = (await panel.getByRole('separator', { name: 'Resize preview' }).boundingBox())!;
  await view.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await view.mouse.down();
  await view.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 - 80, { steps: 4 });
  await view.mouse.up();
  const resized = (await panel.boundingBox())!.height;
  expect(resized).toBeGreaterThan(before + 60);
  expect(await outlineBottom()).toBeLessThan(outlineBefore - 60);
  expect(await outlineBottom()).toBeLessThanOrEqual(await panelTop());

  // Collapsing leaves just the bar and gives the outline the space back.
  await toggle().click();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('.preview-body')).toHaveCount(0);
  expect((await panel.boundingBox())!.height).toBeLessThan(before / 2);
  expect(await outlineBottom()).toBeGreaterThan(outlineBefore);

  // Both are remembered (in chrome.storage.local) across closing and reopening the window.
  const stored = () =>
    sw.evaluate(async () => (await chrome.storage.local.get('previewPanel')).previewPanel);
  await expect.poll(stored).toMatchObject({ expanded: false });
  const reopen = async () => {
    await view.close();
    const pagePromise = context.waitForEvent('page', (p) =>
      p.url().includes('src/view/index.html'),
    );
    await sw.evaluate(() =>
      (
        globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
      ).tabHammer.openOrFocus(),
    );
    view = await pagePromise;
    await view.waitForLoadState();
    panel = view.getByTestId('preview-panel');
  };
  await reopen();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await toggle().click();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  expect(Math.abs((await panel.boundingBox())!.height - resized)).toBeLessThanOrEqual(1);
  await expect.poll(stored).toMatchObject({ expanded: true });
  await reopen();
  await expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  expect(Math.abs((await panel.boundingBox())!.height - resized)).toBeLessThanOrEqual(1);
});

test('Clear previews deletes every stored preview', async ({ context, sw, view }) => {
  await servePages(context);
  const url = `${ORIGIN}/clearme`;
  const windowId = await sw.evaluate(
    async (u) => (await chrome.windows.create({ url: u }))!.id!,
    url,
  );
  await expect.poll(() => hasPreview(sw, url)).toBe(true);
  // A page Chrome won't capture never triggers an on-demand capture, so it shows
  // exactly what is stored: seed a preview for it straight into the store (the view shares the
  // extension's origin).
  const blankId = await sw.evaluate(
    async (windowId) =>
      (await chrome.tabs.create({ windowId, url: 'about:blank', active: false })).id!,
    windowId,
  );
  await view.evaluate(async () => {
    const canvas = new OffscreenCanvas(640, 360);
    canvas.getContext('2d')!.fillRect(0, 0, 640, 360);
    const image = await canvas.convertToBlob({ type: 'image/jpeg' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('tab-hammer-previews', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('previews', 'readwrite');
    tx.objectStore('previews').put({
      key: 'about:blank',
      capturedAt: Date.now(),
      image,
      width: 640,
      height: 360,
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await expect
    .poll(() =>
      sw.evaluate(async (id) => {
        const { captureOutcomes } = await chrome.storage.session.get('captureOutcomes');
        return (captureOutcomes as Record<string, { outcome: string }> | undefined)?.[id]?.outcome;
      }, windowId),
    )
    .toBe('saved');
  const row = liveRow(view, 'tab', blankId);
  const panel = view.getByTestId('preview-panel');
  await row.hover();
  await expect(panel.locator('.preview-shot')).toHaveCount(1);
  // The background tab finishing its load schedules another capture of the window's visible page,
  // which could otherwise land just after the clear: wait until it has loaded and none is due.
  await expect
    .poll(() =>
      sw.evaluate(async (id) => {
        const loaded = (await chrome.tabs.get(id)).status === 'complete';
        const hooks = (globalThis as unknown as { tabHammer: TestHooks }).tabHammer;
        return loaded && !hooks.capturesPending();
      }, blankId),
    )
    .toBe(true);

  await runMenuAction(view, 'Clear previews');
  await expect(view.getByRole('status').filter({ hasText: 'Cleared' })).toBeVisible();
  expect(await hasPreview(sw, url)).toBe(false);
  // The window's 'saved' outcome is gone too (other windows may record new ones meanwhile).
  expect(
    await sw.evaluate(async (id) => {
      const { captureOutcomes } = await chrome.storage.session.get('captureOutcomes');
      return (captureOutcomes as Record<string, unknown> | undefined)?.[id];
    }, windowId),
  ).toBeUndefined();

  // The panel still shows that tab, and looks its preview up again.
  await expect(panel).toContainText('No preview yet');
  await expect(panel.locator('.preview-shot')).toHaveCount(0);
});

test('Capture missing captures background tabs without switching to them', async ({
  context,
  sw,
  view,
}) => {
  await servePages(context);
  const urls = [`${ORIGIN}/bg-one`, `${ORIGIN}/bg-two`];
  const tabIds = await openBackgroundTabs(context, sw, urls);
  for (const id of tabIds)
    await expect.poll(() => tabInfo(sw, id)).toMatchObject({ status: 'complete' });
  expect(await hasPreview(sw, urls[0]!)).toBe(false);

  await runMenuAction(view, 'Capture missing');
  await expect(view.getByRole('status')).toHaveText('refreshed 2/2 pages');
  for (const url of urls) expect(await hasPreview(sw, url)).toBe(true);
  for (const id of tabIds) expect((await tabInfo(sw, id)).active).toBe(false);

  // Every tab has a preview now, so a second run has nothing to do.
  await runMenuAction(view, 'Capture missing');
  await expect(view.getByRole('status')).toHaveText('Nothing to refresh');
});

test('Stop ends a refresh run after the capture in flight', async ({ context, sw, view }) => {
  await servePages(context);
  // The first tab's page doesn't finish loading until the test lets it (an image on it hangs), so
  // the run is reliably mid-capture (a capture waits for the load) when Stop is pressed.
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await context.route('http://slow.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/hang') {
      await released;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<title>slow</title><img src="/hang">slow',
    });
  });
  const slow = 'http://slow.test/';
  const after = `${ORIGIN}/after`;
  const [slowId, afterId] = (await openBackgroundTabs(context, sw, [slow, after])) as [
    number,
    number,
  ];
  await expect.poll(() => tabInfo(sw, afterId)).toMatchObject({ status: 'complete' });
  await expect.poll(() => tabInfo(sw, slowId)).toMatchObject({ title: 'slow' });
  expect((await tabInfo(sw, slowId)).status).toBe('loading');

  await runMenuAction(view, 'Capture missing');
  await expect(view.getByRole('status')).toHaveText('Refreshing 0/2 pages');
  await view.getByRole('button', { name: 'Stop' }).click();
  await expect(view.getByRole('status')).toHaveText('Stopping…');
  release();
  await expect(view.getByRole('status')).toHaveText('Stopped: refreshed 1/2 pages');
  expect(await hasPreview(sw, slow)).toBe(true);
  expect(await hasPreview(sw, after)).toBe(false);
  await expect(view.getByRole('button', { name: 'Stop' })).toHaveCount(0);
});

test('a preview lasts as long as the outline uses its page: closing the tab drops it, hibernating keeps it', async ({
  context,
  sw,
}) => {
  await servePages(context);
  const closed = `${ORIGIN}/closed`;
  const hibernated = `${ORIGIN}/hibernated`;
  // Each the visible tab of its own window, so the service worker captures it.
  const closedTab = await sw.evaluate(async (url) => {
    const win = await chrome.windows.create({ url });
    // A second tab, so closing the first leaves the window (and its row) open.
    await chrome.tabs.create({ windowId: win!.id!, url: 'about:blank', active: false });
    return win!.tabs![0]!.id!;
  }, closed);
  await sw.evaluate((url) => chrome.windows.create({ url }), hibernated);
  await expect.poll(() => hasPreview(sw, closed)).toBe(true);
  await expect.poll(() => hasPreview(sw, hibernated)).toBe(true);

  // Hibernating keeps the tab's row, so its preview stays.
  const findTab = async (url: string) =>
    (await readOutline(sw)).windows.flatMap((w) => w.tabs).find((t) => t.url === url);
  await expect.poll(async () => (await findTab(hibernated))?.id).toBeDefined();
  await outlineCommand(sw, { cmd: 'hibernate', ids: [(await findTab(hibernated))!.id] });
  await expect.poll(async () => (await findTab(hibernated))?.chromeTabId).toBeUndefined();
  await sw.evaluate(() =>
    (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.prunePreviews(),
  );
  expect(await hasPreview(sw, hibernated)).toBe(true);

  // Closing a tab removes its row; no other row or tab has that page, so its preview goes.
  await sw.evaluate((id) => chrome.tabs.remove(id), closedTab);
  await expect.poll(() => hasPreview(sw, closed)).toBe(false);
  expect(await hasPreview(sw, hibernated)).toBe(true);
});

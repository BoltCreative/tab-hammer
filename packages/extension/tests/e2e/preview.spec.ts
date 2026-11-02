import type { BrowserContext, Worker } from '@playwright/test';
import type { TestHooks } from '../../src/background/index';
import { expect, test } from './fixtures';

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

const hasPreview = (sw: Worker, url: string) =>
  sw.evaluate(
    (u) => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.hasPreview(u),
    url,
  );

test('hovering a tab shows its captured preview; an uncapturable page gets a text-only card', async ({
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
  // The service worker records each attempt's outcome after saving; the card reads it below.
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

  const card = view.getByTestId('hover-card');
  const shot = card.locator('.hover-card-shot');
  const row = (tabId: number) => view.locator(`[data-key="t:${tabId}"]`);
  const expectShot = async () => {
    await expect(card).toBeVisible();
    await expect(shot).toHaveJSProperty('complete', true);
    expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  };

  await row(ids.tabId).hover();
  await expectShot();
  await expect(card).toContainText(shotUrl);
  await expect(card).toContainText('Last viewed');
  const shotBox = await card.boundingBox();

  await row(twinId).hover();
  await expect(card).toContainText(`${shotUrl}#section`);
  await expectShot();

  await row(neverId).hover();
  await expect(card).toContainText('about:blank');
  await expect(shot).toHaveCount(0);
  // A tab without a preview says what the window's latest capture attempt did (in friendly text,
  // not the raw outcome code), and gets a muted favicon placeholder instead of a screenshot in the
  // preview area.
  await expect(card).toContainText('A preview was captured but isn’t available for this page');
  await expect(card.locator('.hover-card-preview-favicon')).toBeVisible();
  await expect(row(neverId)).toHaveAttribute('aria-describedby', 'tab-hover-card');
  await expect(card).toHaveAttribute('id', 'tab-hover-card');
  // The fixed-size preview area keeps the card the same height with a screenshot as with the
  // no-preview placeholder — the reported jarring resize no longer happens.
  const noPreviewBox = await card.boundingBox();
  expect(noPreviewBox?.height).toBe(shotBox?.height);

  // The card never gets in the way of selection, and a click closes it.
  await row(neverId).click();
  await expect(row(neverId)).toHaveAttribute('aria-selected', 'true');
  await expect(card).toHaveCount(0);

  // The card closes when the tree changes under it (here the hovered tab navigates).
  await row(twinId).hover();
  await expect(card).toContainText(`${shotUrl}#section`);
  await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://tabhammer.test/moved' }), twinId);
  // Wait for the view to show the navigation first: the card also unmounts briefly while it looks
  // up a preview, so asserting its absence alone could pass without the close-on-change rule.
  await expect(row(twinId)).toContainText('moved');
  await expect(card).toHaveCount(0);
  await expect(row(twinId)).not.toHaveAttribute('aria-describedby');
});

test('hovering a background tab that was never shown captures it on demand', async ({
  context,
  sw,
  view,
}) => {
  await servePages(context);
  const hiddenUrl = `${ORIGIN}/hidden`;
  const tabId = await sw.evaluate(async (url) => {
    const win = await chrome.windows.create({ url: 'about:blank' });
    const tab = await chrome.tabs.create({ windowId: win!.id!, url, active: false });
    return tab.id!;
  }, hiddenUrl);
  // Captures skip pages still loading, so hover once it has loaded.
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).status, tabId))
    .toBe('complete');
  expect(await hasPreview(sw, hiddenUrl)).toBe(false);

  await view.locator(`[data-key="t:${tabId}"]`).hover();
  const card = view.getByTestId('hover-card');
  const shot = card.locator('.hover-card-shot');
  await expect(card).toContainText(hiddenUrl);
  // The card (and its fixed-size preview area) is placed as soon as it's visible, before the
  // on-demand capture resolves — its height doesn't depend on the screenshot landing.
  await expect(card).toBeVisible();
  const boxBeforeShot = await card.boundingBox();
  await expect(shot).toHaveJSProperty('complete', true);
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await expect(card).not.toContainText('Capturing');
  // No layout jump once the screenshot lands.
  expect((await card.boundingBox())?.height).toBe(boxBeforeShot?.height);
  expect(await hasPreview(sw, hiddenUrl)).toBe(true);
  // The tab stayed in the background; the capture didn't switch to it.
  expect(await sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId)).toBe(false);
});

test('Clear previews deletes every stored preview', async ({ context, sw, view }) => {
  await servePages(context);
  const url = `${ORIGIN}/clearme`;
  const windowId = await sw.evaluate(
    async (u) => (await chrome.windows.create({ url: u }))!.id!,
    url,
  );
  await expect.poll(() => hasPreview(sw, url)).toBe(true);
  // The card for a page Chrome won't capture never triggers an on-demand capture, so it shows
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
  const row = view.locator(`[data-key="t:${blankId}"]`);
  const card = view.getByTestId('hover-card');
  await row.hover();
  await expect(card.locator('.hover-card-shot')).toHaveCount(1);

  await view.getByRole('button', { name: 'Clear previews' }).click();
  await expect(view.getByRole('status').filter({ hasText: 'Cleared' })).toBeVisible();
  expect(await hasPreview(sw, url)).toBe(false);
  // The window's 'saved' outcome is gone too (other windows may record new ones meanwhile).
  expect(
    await sw.evaluate(async (id) => {
      const { captureOutcomes } = await chrome.storage.session.get('captureOutcomes');
      return (captureOutcomes as Record<string, unknown> | undefined)?.[id];
    }, windowId),
  ).toBeUndefined();

  await row.hover();
  await expect(card).toContainText('No preview yet');
  await expect(card.locator('.hover-card-shot')).toHaveCount(0);
});

test("clearing Chrome's history deletes the matching previews, and all of them on a full wipe", async ({
  context,
  sw,
}) => {
  await servePages(context);
  const forget = `${ORIGIN}/forget`;
  const keep = `${ORIGIN}/keep`;
  // Each in its own window, so each is a visible tab the service worker captures.
  await sw.evaluate(
    async (urls) => {
      for (const url of urls) await chrome.windows.create({ url });
    },
    [forget, keep],
  );
  await expect.poll(() => hasPreview(sw, forget)).toBe(true);
  await expect.poll(() => hasPreview(sw, keep)).toBe(true);

  // Removing one page's history (the History page's "Remove from history").
  await sw.evaluate((url) => chrome.history.deleteUrl({ url }), forget);
  await expect.poll(() => hasPreview(sw, forget)).toBe(false);
  expect(await hasPreview(sw, keep)).toBe(true);

  // "Clear browsing data" for all time.
  await sw.evaluate(() => chrome.history.deleteAll());
  await expect.poll(() => hasPreview(sw, keep)).toBe(false);
});

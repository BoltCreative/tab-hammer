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

test('hovering a tab shows its captured preview; a never-seen page gets a text-only card', async ({
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

  // Background tabs are never visible, so never captured: one on the same page (previews are
  // keyed by URL, fragment ignored, so it shares the shot) and one on a page never shown.
  const [twinId, neverId] = await sw.evaluate(
    async ({ windowId, twin, never }) => {
      const a = await chrome.tabs.create({ windowId, url: twin, active: false });
      const b = await chrome.tabs.create({ windowId, url: never, active: false });
      return [a.id!, b.id!];
    },
    { windowId: ids.windowId, twin: `${shotUrl}#section`, never: `${ORIGIN}/never` },
  );

  const card = view.getByTestId('hover-card');
  const row = (tabId: number) => view.locator(`[data-key="t:${tabId}"]`);
  const expectShot = async () => {
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveJSProperty('complete', true);
    expect(await card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(
      640,
    );
  };

  await row(ids.tabId).hover();
  await expectShot();
  await expect(card).toContainText(shotUrl);
  await expect(card).toContainText('Last viewed');

  await row(twinId).hover();
  await expect(card).toContainText(`${shotUrl}#section`);
  await expectShot();

  await row(neverId).hover();
  await expect(card).toContainText(`${ORIGIN}/never`);
  await expect(card.locator('img')).toHaveCount(0);
  await expect(row(neverId)).toHaveAttribute('aria-describedby', 'tab-hover-card');
  await expect(card).toHaveAttribute('id', 'tab-hover-card');

  // The card never gets in the way of selection, and a click closes it.
  await row(neverId).click();
  await expect(row(neverId)).toHaveAttribute('aria-selected', 'true');
  await expect(card).toHaveCount(0);

  // The card closes when the tree changes under it (here the hovered tab navigates).
  await row(twinId).hover();
  await expect(card).toContainText(`${shotUrl}#section`);
  await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://tabhammer.test/moved' }), twinId);
  await expect(card).toHaveCount(0);
  await expect(row(twinId)).not.toHaveAttribute('aria-describedby');
});

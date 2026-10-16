import {
  test as base,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import path from 'node:path';

// Built by `npm run build:e2e`. Kept apart from ~/.tab-hammer/dist, which the user's dev server
// writes and their own Chrome loads, so gate runs never clobber it.
const DIST = path.resolve(import.meta.dirname, '../../dist-e2e');
const VIEW_PATH = 'src/view/index.html';

type Fixtures = { context: BrowserContext; sw: Worker; view: Page };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    // channel 'chromium' = full Chromium in new headless mode, which supports extensions
    // (the default headless shell does not). The '' user-data dir makes this a throwaway profile.
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
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
});

export { expect } from '@playwright/test';

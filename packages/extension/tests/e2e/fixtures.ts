import {
  test as base,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import path from 'node:path';
import type { WindowRec } from '../../src/model/outline/types';
import type { OutlineCommand } from '../../src/shared/outlineMessages';

// Built by `npm run build:e2e`. Kept apart from ~/.tab-hammer/dist, which the user's dev server
// writes and their own Chrome loads, so gate runs never clobber it.
const DIST = path.resolve(import.meta.dirname, '../../dist-e2e');
const VIEW_PATH = 'src/view/index.html';

type Fixtures = { context: BrowserContext; sw: Worker; view: Page };

/**
 * Launches Chromium with the built extension. channel 'chromium' = full Chromium in new headless
 * mode, which supports extensions (the default headless shell does not). The default '' user-data
 * dir makes a throwaway profile; pass a real one to put files in it first (e.g. a native host).
 */
export function launchWithExtension(
  userDataDir = '',
  env?: Record<string, string>,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    ...(env && { env: { ...(process.env as Record<string, string>), ...env } }),
  });
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await launchWithExtension();
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

export { expect } from '@playwright/test';

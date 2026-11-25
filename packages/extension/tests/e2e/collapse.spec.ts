import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { expect, liveRow, synced, test } from './fixtures';

// Collapsed windows and groups are remembered (chrome.storage.local, by Tab Hammer's own IDs) and
// shared live by every view; a docked panel's open-time recenter expands its window there only.

const VIEW_PATH = 'src/view/index.html';
const PANEL_PATH = 'src/view/panel.html';

const page = (title: string) => `data:text/html,<title>${title}</title>`;

/**
 * A new window of `titles`, the first one current; with `group`, its first two tabs grouped.
 * Returns Chrome's IDs.
 */
function makeWindow(
  sw: Worker,
  titles: string[],
  group = false,
): Promise<{ windowId: number; tabIds: number[]; groupId?: number }> {
  return sw.evaluate(
    async ({ urls, group }) => {
      const w = (await chrome.windows.create({ url: urls }))!;
      const tabIds = w.tabs!.map((t) => t.id!);
      await chrome.tabs.update(tabIds[0]!, { active: true });
      const groupId = group
        ? await chrome.tabs.group({
            tabIds: [tabIds[0]!, tabIds[1]!],
            createProperties: { windowId: w.id! },
          })
        : undefined;
      return { windowId: w.id!, tabIds, groupId };
    },
    { urls: titles.map(page), group },
  );
}

/** Opens (or focuses) the standalone view the way the toolbar click does. */
async function openView(context: BrowserContext, sw: Worker): Promise<Page> {
  const pagePromise = context.waitForEvent('page', (p) => p.url().includes(VIEW_PATH));
  await sw.evaluate(() =>
    (
      globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
    ).tabHammer.openOrFocus(),
  );
  const view = await pagePromise;
  await view.waitForLoadState();
  return view;
}

/** panel.html as a background tab in `windowId`: a docked panel's page sitting in that window. */
async function openPanelIn(context: BrowserContext, sw: Worker, windowId: number): Promise<Page> {
  const pagePromise = context.waitForEvent('page', (p) => p.url().includes(PANEL_PATH));
  await sw.evaluate(
    async ({ windowId, url }) => void (await chrome.tabs.create({ windowId, url, active: false })),
    { windowId, url: `chrome-extension://${new URL(sw.url()).host}/${PANEL_PATH}` },
  );
  const panel = await pagePromise;
  await expect(panel.locator('main.outline')).toBeVisible();
  return panel;
}

/** The tab rows shown under a live window's header. */
function tabRowsOf(view: Page, windowId: number): Locator {
  return view.locator(`section:has(> [data-window-id="${windowId}"]) [data-kind="tab"]`);
}

test('collapsed windows and groups survive reopening the view, and every view follows them', async ({
  context,
  sw,
  view,
}) => {
  const a = await makeWindow(sw, ['A0', 'A1']);
  const b = await makeWindow(sw, ['B0', 'B1', 'B2'], true);
  const c = await makeWindow(sw, ['C0']);
  await synced(sw, view);

  await liveRow(view, 'window', a.windowId).locator('.twisty').click();
  await liveRow(view, 'group', b.groupId!).locator('.twisty').click();
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(0);
  await expect(tabRowsOf(view, b.windowId)).toHaveCount(1); // B2, outside the group

  // Another view (a docked panel's page, sitting in a third window) shows them collapsed too.
  const panel = await openPanelIn(context, sw, c.windowId);
  await expect(liveRow(panel, 'window', a.windowId)).toBeVisible();
  await expect(tabRowsOf(panel, a.windowId)).toHaveCount(0);
  await expect(tabRowsOf(panel, b.windowId)).toHaveCount(1);

  // Expanding A there expands it here.
  await liveRow(panel, 'window', a.windowId).locator('.twisty').click();
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(2);
  await liveRow(panel, 'window', a.windowId).locator('.twisty').click();
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(0);

  // Reopened, the view starts as it was left.
  await view.close();
  const again = await openView(context, sw);
  await expect(liveRow(again, 'group', b.groupId!)).toBeVisible();
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(0);
  await expect(tabRowsOf(again, b.windowId)).toHaveCount(1);
  // Chrome's own group stays expanded: the collapse is Tab Hammer's alone.
  expect(await sw.evaluate((id) => chrome.tabGroups.get(id), b.groupId!)).toMatchObject({
    collapsed: false,
  });
});

test('a docked panel opening on its collapsed window expands it in that panel only', async ({
  context,
  sw,
  view,
}) => {
  const a = await makeWindow(sw, ['A0', 'A1']);
  await synced(sw, view);
  await liveRow(view, 'window', a.windowId).locator('.twisty').click();
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(0);

  // The panel opens recentered on A's current tab, so A is expanded there…
  const panel = await openPanelIn(context, sw, a.windowId);
  await expect(liveRow(panel, 'tab', a.tabIds[0]!)).toHaveAttribute('data-cursor', 'true');
  await expect(tabRowsOf(panel, a.windowId)).toHaveCount(3); // A0, A1, the panel page's tab
  // …and still collapsed everywhere else, including a view opened afterwards.
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(0);
  await view.close();
  const again = await openView(context, sw);
  await expect(liveRow(again, 'window', a.windowId)).toBeVisible();
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(0);

  // Collapsing it in the panel folds it there; expanding it there then expands it everywhere.
  await liveRow(panel, 'window', a.windowId).locator('.twisty').click();
  await expect(tabRowsOf(panel, a.windowId)).toHaveCount(0);
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(0);
  await liveRow(panel, 'window', a.windowId).locator('.twisty').click();
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(3);
});

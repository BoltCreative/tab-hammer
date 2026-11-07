import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { expect, liveRow, test } from './fixtures';

// Current tabs (each window shows just its active tab) and recenter (scroll to the current
// window's active tab, with the cursor on it).

const VIEW_PATH = 'src/view/index.html';
const PANEL_PATH = 'src/view/panel.html';

const page = (title: string) => `data:text/html,<title>${title}</title>`;

/** A new window holding `titles`, its tab `active` (index) made current. Returns Chrome's IDs. */
async function makeWindow(
  sw: Worker,
  titles: string[],
  active = 0,
): Promise<{ windowId: number; tabIds: number[] }> {
  return sw.evaluate(
    async ({ urls, active }) => {
      const w = (await chrome.windows.create({ url: urls }))!;
      const tabIds = w.tabs!.map((t) => t.id!);
      await chrome.tabs.update(tabIds[active]!, { active: true });
      return { windowId: w.id!, tabIds };
    },
    { urls: titles.map(page), active },
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

/** The tab rows shown under a live window's header. */
function tabRowsOf(view: Page, windowId: number): Locator {
  return view.locator(`section:has(> [data-window-id="${windowId}"]) [data-kind="tab"]`);
}

type FocusCall = [windowId: number, updateInfo: chrome.windows.UpdateInfo];

/**
 * Records the page's chrome.windows.update calls (still calling through): headless Chromium
 * ignores focus changes, so focus is asserted on the calls made.
 */
async function recordFocusCalls(view: Page): Promise<() => Promise<FocusCall[]>> {
  await view.evaluate(() => {
    const calls: FocusCall[] = [];
    (window as unknown as { __focusCalls: FocusCall[] }).__focusCalls = calls;
    const original = chrome.windows.update.bind(chrome.windows);
    chrome.windows.update = ((windowId: number, updateInfo: chrome.windows.UpdateInfo) => {
      calls.push([windowId, updateInfo]);
      return original(windowId, updateInfo);
    }) as typeof chrome.windows.update;
  });
  return () =>
    view.evaluate(() => (window as unknown as { __focusCalls: FocusCall[] }).__focusCalls);
}

test('Current tabs shows one row per window, follows the active tab live, yields to search, and is remembered', async ({
  context,
  sw,
  view,
}) => {
  const a = await makeWindow(sw, ['A0', 'A1', 'A2'], 1);
  const b = await makeWindow(sw, ['B0', 'B1'], 0);
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(3);

  const toggle = view.getByRole('button', { name: 'Current tabs' });
  // Recenter is a docked panel's only: the standalone window can't be sure which window is current.
  await expect(view.getByRole('button', { name: 'Go to the current window' })).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(tabRowsOf(view, a.windowId)).toHaveCount(1);
  await expect(tabRowsOf(view, a.windowId)).toHaveAttribute('data-tab-id', String(a.tabIds[1]));
  await expect(tabRowsOf(view, b.windowId)).toHaveCount(1);
  await expect(tabRowsOf(view, b.windowId)).toHaveAttribute('data-tab-id', String(b.tabIds[0]));

  // Switching the active tab in Chrome swaps the row.
  await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), a.tabIds[2]!);
  await expect(tabRowsOf(view, a.windowId)).toHaveAttribute('data-tab-id', String(a.tabIds[2]));

  // A search covers every tab; clearing it returns to current tabs.
  await view.keyboard.type('B1');
  await expect(liveRow(view, 'tab', b.tabIds[1]!)).toBeVisible();
  await expect(liveRow(view, 'tab', b.tabIds[0]!)).toHaveCount(0);
  await view.keyboard.press('Escape');
  await expect(tabRowsOf(view, b.windowId)).toHaveCount(1);
  await expect(tabRowsOf(view, b.windowId)).toHaveAttribute('data-tab-id', String(b.tabIds[0]));

  // Remembered: a reopened view starts in Current tabs.
  await view.close();
  const again = await openView(context, sw);
  await expect(again.getByRole('button', { name: 'Current tabs' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(1);

  // ⌘/ (Ctrl+/ off a Mac) turns it off again.
  await again.keyboard.press('ControlOrMeta+Slash');
  await expect(tabRowsOf(again, a.windowId)).toHaveCount(3);
});

test('in Current tabs, ↓ steps through windows’ current tabs, and Enter or a click focuses that window on it', async ({
  sw,
  view,
}) => {
  const a = await makeWindow(sw, ['A0', 'A1'], 1);
  const b = await makeWindow(sw, ['B0', 'B1', 'B2'], 2);
  const focusCalls = await recordFocusCalls(view);
  await expect(tabRowsOf(view, b.windowId)).toHaveCount(3);
  await view.keyboard.press('ControlOrMeta+Slash');
  await expect(tabRowsOf(view, b.windowId)).toHaveCount(1);

  // ↓ lands only on tab rows (window headers of live windows are skipped).
  const target = liveRow(view, 'tab', b.tabIds[2]!);
  const cursor = view.locator('[data-cursor]');
  for (let i = 0; i < 10; i++) {
    await view.keyboard.press('ArrowDown');
    await expect(cursor).toHaveAttribute('data-kind', 'tab');
    if ((await cursor.getAttribute('data-tab-id')) === String(b.tabIds[2])) break;
  }
  await expect(target).toHaveAttribute('data-cursor', 'true');
  await view.keyboard.press('Enter');
  await expect.poll(focusCalls).toContainEqual([b.windowId, { focused: true }]);

  // A plain click on a current tab goes there too.
  await liveRow(view, 'tab', a.tabIds[1]!).click();
  await expect.poll(focusCalls).toContainEqual([a.windowId, { focused: true }]);
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, a.tabIds[1]!))
    .toBe(true);
});

test('recenter brings the current window’s active tab to the middle of the list, expanding what hides it', async ({
  context,
  sw,
}) => {
  // Windows before and after a long one whose active tab is 80 rows down.
  for (let i = 0; i < 4; i++) await makeWindow(sw, [`Before ${i}a`, `Before ${i}b`]);
  const titles = Array.from({ length: 100 }, (_, i) => `Long ${i}`);
  const long = await makeWindow(sw, titles, 80);
  for (let i = 0; i < 4; i++) await makeWindow(sw, [`After ${i}a`, `After ${i}b`]);
  const targetId = long.tabIds[80]!;

  // A docked panel's page, opened as a background tab in the long window so that window's active
  // tab stays put: its current window is that one.
  const pagePromise = context.waitForEvent('page', (p) => p.url().includes(PANEL_PATH));
  await sw.evaluate(
    async ({ windowId, url }) => void (await chrome.tabs.create({ windowId, url, active: false })),
    { windowId: long.windowId, url: `chrome-extension://${new URL(sw.url()).host}/${PANEL_PATH}` },
  );
  const panel = await pagePromise;
  const list = panel.locator('main.outline');
  const row = liveRow(panel, 'tab', targetId);
  const centered = async () => {
    const l = (await list.boundingBox())!;
    const r = (await row.boundingBox())!;
    return Math.abs(r.y + r.height / 2 - (l.y + l.height / 2)) < 20;
  };

  // The panel opens recentered on it.
  await expect(row).toHaveAttribute('data-cursor', 'true');
  await expect.poll(centered).toBe(true);

  // Scrolled away, with its window collapsed: the button expands it and comes back.
  await liveRow(panel, 'window', long.windowId).locator('.twisty').click();
  await expect(row).toHaveCount(0);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await panel.getByRole('button', { name: 'Go to the current window' }).click();
  await expect(row).toHaveAttribute('data-cursor', 'true');
  await expect.poll(centered).toBe(true);

  // In a collapsed group, scrolled to the top: ⌘\ (Ctrl+\ off a Mac) expands the group.
  const groupId = await sw.evaluate(
    ([windowId, id]) => chrome.tabs.group({ tabIds: [id], createProperties: { windowId } }),
    [long.windowId, targetId] as const,
  );
  const group = liveRow(panel, 'group', groupId);
  await expect(group).toBeVisible();
  await group.locator('.twisty').click();
  await expect(row).toHaveCount(0);
  await list.evaluate((el) => (el.scrollTop = 0));
  await panel.keyboard.press('ControlOrMeta+Backslash');
  await expect(row).toHaveAttribute('data-cursor', 'true');
  await expect.poll(centered).toBe(true);

  // In Current tabs it's the same row.
  await panel.getByRole('button', { name: 'Current tabs' }).click();
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await panel.getByRole('button', { name: 'Go to the current window' }).click();
  await expect(row).toHaveAttribute('data-cursor', 'true');
  await expect.poll(centered).toBe(true);
});

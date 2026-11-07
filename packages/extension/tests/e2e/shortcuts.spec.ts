import { expect, runMenuAction, test } from './fixtures';

// The Keyboard shortcuts sheet: opened from the Actions menu or its own key, listing the view's
// keys and Chrome's shortcut that opens Tab Hammer, closed by Escape.

test('Keyboard shortcuts lists the keys and the open shortcut, and Escape closes it', async ({
  sw,
  view,
}) => {
  // What Chrome has bound to the toolbar click right now (the suggested Alt+Shift+H, unless taken).
  const openKeys = await view.evaluate(
    async () =>
      (await chrome.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut ?? '',
  );

  await runMenuAction(view, 'Keyboard shortcuts');
  const sheet = view.getByRole('region', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.shortcuts-row', { hasText: 'Open Tab Hammer' })).toContainText(
    openKeys || 'not set',
  );
  // ⌘ on a Mac, Ctrl elsewhere.
  await expect(sheet.locator('.shortcuts-row', { hasText: 'Current tabs' })).toContainText(
    process.platform === 'darwin' ? '⌘/' : 'Ctrl+/',
  );

  await view.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(view.getByRole('combobox', { name: 'Search tabs by title or URL' })).toBeFocused();

  // Its own key opens it too, and Change… opens Chrome's shortcut settings.
  await view.keyboard.press("ControlOrMeta+'");
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Change…' }).click();
  await expect
    .poll(() =>
      sw.evaluate(async () =>
        (await chrome.tabs.query({})).some((t) =>
          (t.url || t.pendingUrl || '').startsWith('chrome://extensions/shortcuts'),
        ),
      ),
    )
    .toBe(true);
});

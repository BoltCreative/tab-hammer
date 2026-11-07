import { useEffect, useState } from 'react';

/** Where Chrome lets the user change an extension's shortcuts. A plain link to it won't open. */
export const SHORTCUT_SETTINGS_URL = 'chrome://extensions/shortcuts';

/**
 * The shortcut that opens Tab Hammer (the manifest's `_execute_action`) as the user has it now:
 * Chrome's own label ("⌥⇧H", "Alt+Shift+H"), '' when unset, undefined until read.
 */
export function useOpenShortcut(): string | undefined {
  const [keys, setKeys] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    chrome.commands
      .getAll()
      .then((all) => {
        if (live) setKeys(all.find((c) => c.name === '_execute_action')?.shortcut ?? '');
      })
      .catch((err: unknown) => {
        console.error('Tab Hammer: reading the extension shortcuts failed', err);
        if (live) setKeys('');
      });
    return () => {
      live = false;
    };
  }, []);
  return keys;
}

export function openShortcutSettings(): void {
  void chrome.tabs.create({ url: SHORTCUT_SETTINGS_URL });
}

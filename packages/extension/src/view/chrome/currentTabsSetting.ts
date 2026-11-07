// The Current tabs toggle, remembered in chrome.storage.local so it survives reopening and is
// shared live by the standalone window and every docked panel: each view follows storage changes,
// so flipping it in one flips it in all.
import { useCallback, useEffect, useState } from 'react';

export const CURRENT_TABS_KEY = 'currentTabs';

export function useCurrentTabsSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    chrome.storage.local
      .get(CURRENT_TABS_KEY)
      .then((s) => {
        if (live) setOn(s[CURRENT_TABS_KEY] === true);
      })
      .catch((err: unknown) => console.error('Tab Hammer: reading Current tabs failed', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && CURRENT_TABS_KEY in changes) {
        setOn(changes[CURRENT_TABS_KEY]!.newValue === true);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    chrome.storage.local
      .set({ [CURRENT_TABS_KEY]: next })
      .catch((err: unknown) => console.error('Tab Hammer: saving Current tabs failed', err));
  }, []);
  return [on, set];
}

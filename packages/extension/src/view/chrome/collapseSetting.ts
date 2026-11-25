// Which windows and groups are collapsed in the outline, remembered in chrome.storage.local so it
// survives reopening the view and restarting the browser (collapsing old windows is how they get
// put away), and shared live by the standalone window and every docked panel: each view follows
// storage changes, so collapsing a window in one collapses it in all. Keyed by Tab Hammer's own
// IDs (the rows' keys), which outlive Chrome's.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fromStoredCollapse, toStoredCollapse, type CollapseState } from '../../model/visibleRows';

export const COLLAPSE_KEY = 'collapse';

const EMPTY: CollapseState = { collapsedWindows: new Set(), groupOverrides: new Map() };

/**
 * The shared collapse state, an updater that saves it, and whether it has been read yet. The
 * updater runs against the latest state this view has; one that returns its argument unchanged
 * saves nothing, and until the stored state is read it does nothing, so an early change can't
 * overwrite what's stored.
 */
export function useCollapseSetting(): [
  CollapseState,
  (change: (c: CollapseState) => CollapseState) => void,
  boolean,
] {
  const [state, setState] = useState<CollapseState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const current = useRef(state);
  const isLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    chrome.storage.local
      .get(COLLAPSE_KEY)
      .then((s) => {
        if (!live) return;
        current.current = fromStoredCollapse(s[COLLAPSE_KEY]);
        isLoaded.current = true;
        setState(current.current);
        setLoaded(true);
      })
      .catch((err: unknown) => console.error('Tab Hammer: reading collapsed rows failed', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && COLLAPSE_KEY in changes) {
        current.current = fromStoredCollapse(changes[COLLAPSE_KEY]!.newValue);
        setState(current.current);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  const update = useCallback((change: (c: CollapseState) => CollapseState) => {
    if (!isLoaded.current) return;
    const next = change(current.current);
    if (next === current.current) return;
    current.current = next;
    setState(next);
    chrome.storage.local
      .set({ [COLLAPSE_KEY]: toStoredCollapse(next) })
      .catch((err: unknown) => console.error('Tab Hammer: saving collapsed rows failed', err));
  }, []);
  return [state, update, loaded];
}

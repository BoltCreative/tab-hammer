import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** How long the pointer rests on a tab row before the preview panel switches to it. */
export const HOVER_DELAY_MS = 200;

export interface HoverHandlers {
  onRowEnter: (key: string) => void;
  onRowLeave: () => void;
}

export interface PreviewTarget {
  key: string | null; // the tab row to show, if any yet
  hover: HoverHandlers;
  show: (key: string) => void; // the keyboard cursor moved to this tab row: show it now
}

/**
 * Which tab the preview panel shows: the tab row the pointer last rested on for HOVER_DELAY_MS,
 * or the tab row passed to `show` (the keyboard cursor, moved by a click or arrow key), whichever
 * happened last. Leaving a row keeps it: the panel never goes blank because the pointer moved
 * off the outline. The delay keeps a sweep across many rows from flashing through (and asking for
 * a capture of) every one.
 */
export function usePreviewTarget(): PreviewTarget {
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onRowLeave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const onRowEnter = useCallback(
    (k: string) => {
      onRowLeave();
      timer.current = setTimeout(() => setKey(k), HOVER_DELAY_MS);
    },
    [onRowLeave],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback(
    (k: string) => {
      onRowLeave();
      setKey(k);
    },
    [onRowLeave],
  );

  const hover = useMemo(() => ({ onRowEnter, onRowLeave }), [onRowEnter, onRowLeave]);
  return { key, hover, show };
}

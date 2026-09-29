import { useCallback, useEffect, useRef, useState } from 'react';

export const HOVER_DELAY_MS = 400;

export interface HoverTarget {
  key: string; // the hovered tab row's key
  row: { top: number; bottom: number }; // its viewport rect when the card opened
}

export interface HoverHandlers {
  onRowEnter: (key: string, el: HTMLElement) => void;
  onRowLeave: () => void;
}

/**
 * Hover-intent state for the tab preview card: opens after the pointer rests on a tab row for
 * HOVER_DELAY_MS; closes on leaving the row, any scroll, or any mouse button press (so clicks,
 * modifier-clicks, and double-clicks behave exactly as without the card).
 */
export function useHoverCard(): [HoverTarget | null, HoverHandlers] {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setTarget(null);
  }, []);

  const onRowEnter = useCallback(
    (key: string, el: HTMLElement) => {
      close();
      timer.current = setTimeout(() => {
        const { top, bottom } = el.getBoundingClientRect();
        setTarget({ key, row: { top, bottom } });
      }, HOVER_DELAY_MS);
    },
    [close],
  );

  useEffect(() => {
    // Capture phase so a scroll of any element, or a press that a row stops, still closes it.
    window.addEventListener('scroll', close, true);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', close);
      clearTimeout(timer.current);
    };
  }, [close]);

  return [target, { onRowEnter, onRowLeave: close }];
}

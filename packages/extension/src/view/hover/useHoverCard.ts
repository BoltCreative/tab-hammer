import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

export const HOVER_DELAY_MS = 400;
export const HOVER_CARD_ID = 'tab-hover-card';

export interface HoverTarget {
  key: string; // the hovered tab row's key
  row: { top: number; bottom: number }; // its viewport rect when the card opened
  signature: string; // what the card sat on when it opened (see hoverSignature)
}

export interface HoverHandlers {
  onRowEnter: (key: string, el: HTMLElement) => void;
  onRowLeave: () => void;
  openKey: string | null; // the row whose card is open, for aria-describedby
}

/**
 * Hover-intent state for the tab preview card: opens after the pointer rests on a tab row for
 * HOVER_DELAY_MS; closes on leaving the row, a scroll of the outline list (`scrollRoot`; the
 * header above it doesn't scroll), any mouse button press (so clicks,
 * modifier-clicks, and double-clicks behave exactly as without the card), window blur, or when
 * `signatureOf(key)` changes (the tree changed under the card).
 */
export function useHoverCard(
  signatureOf: (key: string) => string | undefined,
  scrollRoot: RefObject<HTMLElement | null>,
): [HoverTarget | null, HoverHandlers] {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The open timer fires later, so it reads the latest tree through this ref.
  const signatureRef = useRef(signatureOf);
  useLayoutEffect(() => {
    signatureRef.current = signatureOf;
  });

  const close = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setTarget(null);
  }, []);

  const onRowEnter = useCallback(
    (key: string, el: HTMLElement) => {
      close();
      timer.current = setTimeout(() => {
        const signature = signatureRef.current(key);
        if (signature === undefined) return;
        const { top, bottom } = el.getBoundingClientRect();
        setTarget({ key, row: { top, bottom }, signature });
      }, HOVER_DELAY_MS);
    },
    [close],
  );

  useEffect(() => {
    // Capture phase so a scroll of anything inside the list, or a press that a row stops, still
    // closes it.
    const list = scrollRoot.current;
    list?.addEventListener('scroll', close, true);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', close);
    return () => {
      list?.removeEventListener('scroll', close, true);
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', close);
      clearTimeout(timer.current);
    };
  }, [close, scrollRoot]);

  // A card whose tree changed underneath it stays closed until the pointer enters a row again.
  const open = target && signatureOf(target.key) === target.signature ? target : null;
  const openKey = open?.key ?? null;
  const handlers = useMemo(
    () => ({ onRowEnter, onRowLeave: close, openKey }),
    [onRowEnter, close, openKey],
  );
  return [open, handlers];
}

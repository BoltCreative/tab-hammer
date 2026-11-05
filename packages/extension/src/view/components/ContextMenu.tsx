import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string; // tooltip
}

interface Props {
  x: number; // viewport coordinates of the right-click (or the menu button's corner)
  y: number;
  items: MenuItem[];
  onClose: () => void;
  label?: string; // the menu's accessible name
  /** The button that toggles the menu: a press on it is left to the button, not a close. */
  anchor?: RefObject<HTMLElement | null>;
  /** Focus the first item on open (opened from the keyboard or a menu button). */
  autoFocus?: boolean;
  /** 'right': x is the menu's right edge (under a menu button at the window's right). */
  align?: 'left' | 'right';
}

const EDGE = 4; // keep the menu this far inside the viewport

/**
 * A menu at (x, y), for right-clicks and menu buttons. Closes on pick, Escape, a click elsewhere,
 * scroll, or blur. Up and Down move between items.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label,
  anchor,
  autoFocus,
  align = 'left',
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip/clamp so the menu never spills past the window edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = align === 'right' ? x - width : x;
    setPos({
      left: Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
    if (autoFocus) el.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y, autoFocus, align]);

  useEffect(() => {
    const onDown = (e: Event) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        anchor?.current?.focus();
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const enabled = [
        ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
      ];
      if (enabled.length === 0) return;
      e.preventDefault();
      const at = enabled.indexOf(document.activeElement as HTMLElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      enabled[(at + step + enabled.length) % enabled.length]!.focus();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('contextmenu', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('contextmenu', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose, anchor]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      data-testid="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="context-menu-item"
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

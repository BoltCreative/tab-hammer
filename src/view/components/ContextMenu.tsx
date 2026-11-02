import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface Props {
  x: number; // viewport coordinates of the right-click
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 4; // keep the menu this far inside the viewport

/** A right-click menu at (x, y). Closes on pick, Escape, a click elsewhere, scroll, or blur. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip/clamp so the menu never spills past the window edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
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

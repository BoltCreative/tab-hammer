import type { ReactNode, SyntheticEvent } from 'react';

export interface RowAction {
  label: string; // the button's accessible name
  icon: ReactNode;
  onClick: () => void;
}

// The toolbar's clicks are its own: no row selection, no double-click action, no drag start.
const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Small icon buttons overlaid at a row's right edge, shown while the row is hovered (theme.css).
 * Absolutely positioned, so the row's layout doesn't change.
 */
export function RowToolbar({ actions }: { actions: RowAction[] }) {
  return (
    <div
      className="row-toolbar"
      onMouseDown={(e) => {
        // Keep keyboard focus on the row (a focused button would take Enter and Space).
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={stop}
      onDoubleClick={stop}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          tabIndex={-1} // reached by mouse; the keyboard has ⌘⌫ and Enter
          aria-label={a.label}
          title={a.label}
          onClick={(e) => {
            e.stopPropagation();
            a.onClick();
          }}
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const EditIcon = (
  <Icon>
    <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" />
  </Icon>
);

export const HibernateIcon = (
  <Icon>
    <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
  </Icon>
);

export const TrashIcon = (
  <Icon>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5" />
  </Icon>
);

export const RestoreIcon = (
  <Icon>
    <path d="M3 8a5 5 0 1 0 1.8-3.8M3 2.5v3h3" />
  </Icon>
);

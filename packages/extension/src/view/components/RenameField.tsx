import { useRef, type SyntheticEvent } from 'react';

interface Props {
  initial: string;
  placeholder?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * An inline text field over a row's title: Enter or leaving the field saves, Escape cancels.
 * Every key stays in the field, so the outline's shortcuts (Delete, arrows, ...) never fire.
 */
export function RenameField({ initial, placeholder, onSave, onCancel }: Props) {
  // Enter or Escape unmounts the field, which may blur it: only the first outcome counts.
  const done = useRef(false);
  const finish = (save: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(value);
    else onCancel();
  };
  return (
    <input
      className="rename-field"
      type="text"
      aria-label="Window name"
      defaultValue={initial}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true, e.currentTarget.value);
        else if (e.key === 'Escape') finish(false, '');
      }}
      onBlur={(e) => finish(true, e.currentTarget.value)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
    />
  );
}

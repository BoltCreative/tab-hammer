import { useEffect, useRef } from 'react';
import { cheatSheet } from '../../model/shortcuts';
import { openShortcutSettings, useOpenShortcut } from '../chrome/commands';
import { surface } from '../chrome/dock';
import { IS_MAC } from '../platform';

/**
 * The Keyboard shortcuts sheet, in the header's banner area (like the devices panel): every key
 * the view handles, read from the same table the key handlers use, plus Chrome's shortcut that
 * opens Tab Hammer, which the user sets at chrome://extensions/shortcuts. Escape closes it.
 */
export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const openKeys = useOpenShortcut();
  const sections = cheatSheet(IS_MAC, surface === 'panel');
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  return (
    <div
      className="devices-panel shortcuts-panel"
      data-own-keys // its own Escape closes it; the outline's keys stay out
      ref={ref}
      role="region"
      aria-label="Keyboard shortcuts"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="devices-panel-title">
        <strong>Keyboard shortcuts</strong>
        <button type="button" className="toolbar-button" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="shortcuts-list">
        <div className="shortcuts-row">
          <dt>
            {openKeys === undefined ? '…' : openKeys ? <kbd>{openKeys}</kbd> : <em>not set</em>}
          </dt>
          <dd>
            Open Tab Hammer, from anywhere in Chrome.{' '}
            <button type="button" className="link-button" onClick={openShortcutSettings}>
              Change…
            </button>
          </dd>
        </div>
        <div className="shortcuts-row">
          <dt>
            <em>Type</em>
          </dt>
          <dd>Search tabs by title or URL</dd>
        </div>
      </dl>
      {sections.map((s) => (
        <section key={s.title}>
          <h3 className="shortcuts-heading">{s.title}</h3>
          <dl className="shortcuts-list">
            {s.rows.map((r) => (
              <div className="shortcuts-row" key={r.id}>
                <dt>
                  {r.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{r.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { TabNode } from '../../model/types';
import {
  DEFAULT_PANEL_SETTINGS,
  loadPanelSettings,
  savePanelSettings,
  type PanelSettings,
} from '../chrome/panelSettings';
import { TabPreview } from './TabPreview';

export const PREVIEW_PANEL_ID = 'tab-preview-panel';
const BODY_ID = 'tab-preview-panel-body';
const MIN_HEIGHT = 120;
const KEY_STEP = 24;
/** The panel never takes more than this share of the window, so the outline always has room. */
const MAX_SHARE = 0.75;

interface Props {
  /** The tab to show (hovered or selected last), or undefined when there's none (yet). */
  tab: TabNode | undefined;
  previewEpoch: number;
}

/**
 * The tab preview panel docked below the outline. It takes its own space in the window's column
 * (the outline list scrolls above it and never runs under it). Expanded, it shows the tab's
 * preview and details; collapsed, it is only its header bar. Its top edge drags to resize it.
 * Both are remembered in chrome.storage.local (panelSettings). Until they've loaded it isn't
 * drawn, so a collapsed panel doesn't flash open on every reopen.
 */
export function PreviewPanel({ tab, previewEpoch }: Props) {
  const [settings, setSettings] = useState<PanelSettings | null>(null);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPanelSettings()
      .catch(() => undefined)
      .then((s) => {
        if (!cancelled) setSettings(s ?? DEFAULT_PANEL_SETTINGS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) return null;

  const update = (next: PanelSettings, persist = true) => {
    setSettings(next);
    if (persist) {
      savePanelSettings(next).catch((err: unknown) =>
        console.error('Tab Hammer: saving the preview panel layout failed', err),
      );
    }
  };
  const maxHeight = () => {
    const app = ref.current?.parentElement;
    return Math.max(MIN_HEIGHT, Math.floor((app?.clientHeight ?? window.innerHeight) * MAX_SHARE));
  };
  const clamp = (h: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, h)));
  // The height actually drawn (CSS also caps it at MAX_SHARE), which a drag starts from.
  const drawnHeight = () => ref.current?.offsetHeight ?? settings.height;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: drawnHeight() };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    update({ ...settings, height: clamp(d.startHeight + d.startY - e.clientY) }, false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    update(settings);
  };
  const onResizeKey = (e: KeyboardEvent) => {
    const delta = e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowDown' ? -KEY_STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    update({ ...settings, height: clamp(drawnHeight() + delta) });
  };

  const { expanded } = settings;
  return (
    <section
      ref={ref}
      id={PREVIEW_PANEL_ID}
      className={expanded ? 'preview-panel expanded' : 'preview-panel collapsed'}
      style={expanded ? { height: settings.height } : undefined}
      aria-label="Tab preview"
      data-testid="preview-panel"
    >
      {expanded && (
        <div
          className="preview-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize preview"
          aria-controls={BODY_ID}
          aria-valuenow={settings.height}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onResizeKey}
        />
      )}
      <div className="preview-bar">
        <button
          type="button"
          className="preview-toggle"
          aria-expanded={expanded}
          aria-controls={BODY_ID}
          onClick={() => update({ ...settings, expanded: !expanded })}
        >
          <svg className="preview-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>Preview</span>
        </button>
        {!expanded && tab && <span className="preview-bar-title">{tab.title}</span>}
      </div>
      {expanded && (
        <div id={BODY_ID} className="preview-body">
          {tab ? (
            <TabPreview key={tab.key} tab={tab} previewEpoch={previewEpoch} />
          ) : (
            <p className="preview-placeholder">Hover over a tab to preview it</p>
          )}
        </div>
      )}
    </section>
  );
}

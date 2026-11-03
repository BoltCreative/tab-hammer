import { useEffect, useRef, useState } from 'react';
import { STALE_PREVIEW_MS } from '../../shared/previewPolicy';
import { clearAllPreviews } from '../chrome/captureOutcome';
import { PreviewPermissionBanner } from '../permission/PreviewPermissionBanner';
import type { RefreshProgress } from '../refresh/refreshRun';
import { useRefreshPreviews, type RefreshState } from '../refresh/useRefreshPreviews';

const CONFIRM_MS = 1500;

// Attaching the debugger shows Chrome's "started debugging this browser" banner for each tab
// captured in the background, unless Chrome was launched with --silent-debugger-extension-api.
const REFRESH_NOTE =
  "Captures in the background, one tab at a time. Sleeping tabs are skipped. Chrome's debugging banner flashes once per tab.";

function refreshStatus(state: RefreshState): string {
  if (state.phase === 'idle') return '';
  const p: RefreshProgress = state.progress;
  if (state.phase === 'running') {
    if (state.stopping) return 'Stopping…';
    return p.total === 0 ? 'Finding tabs…' : `Refreshing ${p.done}/${p.total}`;
  }
  if (p.total === 0) return 'Nothing to refresh';
  const failed = p.failed > 0 ? `, ${p.failed} failed` : '';
  return `${state.stopped ? 'Stopped: ' : ''}refreshed ${p.saved}/${p.total}${failed}`;
}

/**
 * The view's fixed header: it stays put while the outline scrolls beneath it. Toolbar and action
 * buttons, and the permission banner, go here.
 */
export function AppHeader({ onPreviewsChanged }: { onPreviewsChanged: () => void }) {
  const [status, setStatus] = useState<'idle' | 'clearing' | 'cleared' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const refresh = useRefreshPreviews(onPreviewsChanged);
  const refreshing = refresh.state.phase === 'running';

  // A debug tool, so no confirmation dialog.
  const onClear = () => {
    clearTimeout(timer.current);
    setStatus('clearing');
    clearAllPreviews()
      .then(
        () => {
          onPreviewsChanged();
          setStatus('cleared');
        },
        (err: unknown) => {
          console.error('Tab Hammer: clearing previews failed', err);
          setStatus('failed');
        },
      )
      .finally(() => {
        timer.current = setTimeout(() => setStatus('idle'), CONFIRM_MS);
      });
  };

  const clearStatus = status === 'cleared' ? 'Cleared' : status === 'failed' ? 'Clear failed' : '';

  return (
    <header className="app-header">
      <PreviewPermissionBanner />
      <div className="toolbar" role="toolbar" aria-label="Tab Hammer tools">
        <span className="toolbar-status" role="status">
          {clearStatus || refreshStatus(refresh.state)}
        </span>
        {refreshing ? (
          <button
            type="button"
            className="toolbar-button"
            onClick={refresh.stop}
            disabled={refresh.state.phase === 'running' && refresh.state.stopping}
          >
            Stop
          </button>
        ) : (
          <>
            <button
              type="button"
              className="toolbar-button"
              title={`Capture tabs with no preview, or one older than ${STALE_PREVIEW_MS / 60_000} minutes. ${REFRESH_NOTE}`}
              onClick={() => refresh.start('stale')}
            >
              Refresh stale
            </button>
            <button
              type="button"
              className="toolbar-button"
              title={`Capture every tab again. ${REFRESH_NOTE}`}
              onClick={() => refresh.start('all')}
            >
              Refresh all
            </button>
          </>
        )}
        <button
          type="button"
          className="toolbar-button"
          onClick={onClear}
          disabled={status === 'clearing' || refreshing}
        >
          Clear previews
        </button>
      </div>
    </header>
  );
}

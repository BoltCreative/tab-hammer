import { useEffect, useRef, useState } from 'react';
import { clearAllPreviews } from '../chrome/captureOutcome';
import { PreviewPermissionBanner } from '../permission/PreviewPermissionBanner';

const CONFIRM_MS = 1500;

/**
 * The view's fixed header: it stays put while the outline scrolls beneath it. Toolbar and action
 * buttons, and the permission banner, go here.
 */
export function AppHeader({ onPreviewsCleared }: { onPreviewsCleared: () => void }) {
  const [status, setStatus] = useState<'idle' | 'clearing' | 'cleared' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // A debug tool, so no confirmation dialog.
  const onClear = () => {
    clearTimeout(timer.current);
    setStatus('clearing');
    clearAllPreviews()
      .then(
        () => {
          onPreviewsCleared();
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

  return (
    <header className="app-header">
      <PreviewPermissionBanner />
      <div className="toolbar" role="toolbar" aria-label="Tab Hammer tools">
        <span className="toolbar-status" role="status">
          {status === 'cleared' ? 'Cleared' : status === 'failed' ? 'Clear failed' : ''}
        </span>
        <button
          type="button"
          className="toolbar-button"
          onClick={onClear}
          disabled={status === 'clearing'}
        >
          Clear previews
        </button>
      </div>
    </header>
  );
}

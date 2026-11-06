import { useEffect, useRef, useState } from 'react';
import { clearAllPreviews } from '../chrome/captureOutcome';
import type { MenuItem } from '../components/ContextMenu';
import type { RefreshProgress } from '../refresh/refreshRun';
import { useRefreshPreviews, type RefreshState } from '../refresh/useRefreshPreviews';

const CONFIRM_MS = 1500;

// Refresh is the only thing that attaches the debugger, which shows Chrome's "started debugging
// this browser" banner (and shifts this window's content) unless Chrome was launched with
// --silent-debugger-extension-api.
const REFRESH_NOTE =
  'Captures in the background, one tab at a time. Sleeping tabs are woken to capture them and stay loaded. Chrome shows its debugging banner while it runs.';

function refreshStatus(state: RefreshState): string {
  if (state.phase === 'idle') return '';
  const p: RefreshProgress = state.progress;
  if (state.phase === 'running') {
    if (state.stopping) return 'Stopping…';
    return p.total === 0 ? 'Finding tabs…' : `Refreshing ${p.done}/${p.total} pages`;
  }
  if (p.total === 0) return 'Nothing to refresh';
  // Counted in pages, not tabs: tabs on the same page share one preview. Every page is accounted
  // for, so saved + failed + skipped adds up to the total (less any a Stop left undone).
  const failed = p.failed > 0 ? `, ${p.failed} failed` : '';
  const skipped = p.skipped > 0 ? `, ${p.skipped} skipped` : '';
  return `${state.stopped ? 'Stopped: ' : ''}refreshed ${p.saved}/${p.total} pages${failed}${skipped}`;
}

export interface HeaderActions {
  /** The actions, for the header's menu and the outline background's right-click menu alike. */
  items: MenuItem[];
  /** The latest action's progress or result, for the header's status line ('' when none). */
  status: string;
  /** Stops the Refresh run in progress; undefined when none is running. */
  stop: (() => void) | undefined;
  stopping: boolean;
}

/**
 * The view's bulk actions (Other devices, Close duplicates, Capture missing, Refresh all, Clear previews) and their live
 * state. Owned by App, so the header's menu and the outline's background menu run the same ones.
 */
export function useHeaderActions(opts: {
  onPreviewsChanged: () => void;
  duplicateCount: number; // tabs "Close duplicates" would close
  onCloseDuplicates: () => Promise<void>;
  onOpenDevices: () => void; // shows the devices panel (other computers, checkpoints, sync)
}): HeaderActions {
  const { onPreviewsChanged, duplicateCount, onCloseDuplicates, onOpenDevices } = opts;
  const [clear, setClear] = useState<'idle' | 'clearing' | 'cleared' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const refresh = useRefreshPreviews(onPreviewsChanged);
  const refreshing = refresh.state.phase === 'running';

  // A debug tool, so no confirmation dialog.
  const onClear = () => {
    clearTimeout(timer.current);
    setClear('clearing');
    clearAllPreviews()
      .then(
        () => {
          onPreviewsChanged();
          setClear('cleared');
        },
        (err: unknown) => {
          console.error('Tab Hammer: clearing previews failed', err);
          setClear('failed');
        },
      )
      .finally(() => {
        timer.current = setTimeout(() => setClear('idle'), CONFIRM_MS);
      });
  };

  const items: MenuItem[] = [
    {
      label: 'Other devices…',
      title:
        "See your other computers' and devices' tabs, this computer's checkpoints, and Drive sync",
      onSelect: onOpenDevices,
    },
    {
      label:
        duplicateCount === 0
          ? 'Close duplicates'
          : duplicateCount === 1
            ? 'Close 1 duplicate'
            : `Close ${duplicateCount} duplicates`,
      title: 'Close every tab whose URL is open in another tab, keeping the one you used last',
      disabled: duplicateCount === 0,
      onSelect: () =>
        void onCloseDuplicates().catch((err: unknown) =>
          console.error('Tab Hammer: closing duplicates failed', err),
        ),
    },
    {
      label: 'Capture missing',
      title: `Capture tabs that have no preview yet. A preview is how the tab looked when you last used it, so existing ones are kept. ${REFRESH_NOTE}`,
      disabled: refreshing,
      onSelect: () => refresh.start('missing'),
    },
    {
      label: 'Refresh all',
      title: `Capture every tab again, replacing the previews from when you last used them. ${REFRESH_NOTE}`,
      disabled: refreshing,
      onSelect: () => refresh.start('all'),
    },
    {
      label: 'Clear previews',
      title: 'Delete every stored preview (a debug tool)',
      disabled: clear === 'clearing' || refreshing,
      onSelect: onClear,
    },
  ];

  const clearStatus = clear === 'cleared' ? 'Cleared' : clear === 'failed' ? 'Clear failed' : '';
  return {
    items,
    status: clearStatus || refreshStatus(refresh.state),
    stop: refreshing ? refresh.stop : undefined,
    stopping: refresh.state.phase === 'running' && refresh.state.stopping,
  };
}

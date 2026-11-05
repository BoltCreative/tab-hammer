import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewCapturedAt,
  refreshCandidates,
  refreshTab,
  requestTabCapture,
} from '../chrome/captureOutcome';
import {
  pickRefreshTargets,
  runRefresh,
  type RefreshMode,
  type RefreshProgress,
} from './refreshRun';

const SUMMARY_MS = 4000;

export type RefreshState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: RefreshProgress; stopping: boolean }
  | { phase: 'finished'; progress: RefreshProgress; stopped: boolean };

/**
 * Drives one "Refresh previews" run at a time for the header. `onSaved` fires after each new
 * preview lands, so an open hover card can pick it up.
 */
export function useRefreshPreviews(onSaved: () => void) {
  const [state, setState] = useState<RefreshState>({ phase: 'idle' });
  const run = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);
  useEffect(
    () => () => {
      run.current?.abort();
      clearTimeout(timer.current);
    },
    [],
  );

  const start = useCallback(async (mode: RefreshMode) => {
    if (run.current) return;
    clearTimeout(timer.current);
    const stop = new AbortController();
    run.current = stop;
    const empty = { done: 0, total: 0, saved: 0, failed: 0 };
    setState({ phase: 'running', progress: empty, stopping: false });
    let result = empty;
    try {
      const { tabs, ownWindowId } = await refreshCandidates();
      const shots = new Map(
        await Promise.all(
          tabs.map(
            async (t) =>
              [t.url, await previewCapturedAt(t.url ?? '').catch(() => undefined)] as const,
          ),
        ),
      );
      const targets = pickRefreshTargets(tabs, (u) => shots.get(u), mode, Date.now(), ownWindowId);
      let saved = 0;
      await runRefresh(
        targets,
        mode,
        {
          getTab: refreshTab,
          capturedAt: previewCapturedAt,
          // Refresh is the one place the debugger may be attached (see requestTabCapture).
          capture: (tabId) => requestTabCapture(tabId, true),
          onProgress: (progress) => {
            if (progress.saved > saved) {
              saved = progress.saved;
              onSavedRef.current();
            }
            result = progress;
            setState((s) => (s.phase === 'running' ? { ...s, progress } : s));
          },
        },
        stop.signal,
      );
    } catch (err) {
      console.error('Tab Hammer: refreshing previews failed', err);
    } finally {
      run.current = null;
      setState({ phase: 'finished', progress: result, stopped: stop.signal.aborted });
      timer.current = setTimeout(() => setState({ phase: 'idle' }), SUMMARY_MS);
    }
  }, []);

  const stop = useCallback(() => {
    if (!run.current) return;
    run.current.abort();
    setState((s) => (s.phase === 'running' ? { ...s, stopping: true } : s));
  }, []);

  return { state, start: (mode: RefreshMode) => void start(mode), stop };
}

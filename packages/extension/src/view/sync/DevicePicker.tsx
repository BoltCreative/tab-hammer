import { useEffect, useRef, useState } from 'react';
import type { SyncPickerState, SyncSource } from '../../shared/syncMessages';
import { relativeTime } from '../hover/relativeTime';
import { sendSyncCommand } from './syncClient';

interface Props {
  state: SyncPickerState | null;
  current: SyncSource | null; // null: this computer
  onPick: (source: SyncSource | null) => void;
}

const counts = (w?: number, t?: number) =>
  w === undefined || t === undefined
    ? ''
    : `${w} ${w === 1 ? 'window' : 'windows'}, ${t} ${t === 1 ? 'tab' : 'tabs'}`;

export const checkpointDate = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function logError(err: unknown) {
  console.error('Tab Hammer: sync command failed', err);
}

/** The picker's label for whatever is being shown. */
export function sourceLabel(state: SyncPickerState | null, source: SyncSource | null): string {
  if (!source) return 'This computer';
  if (source.kind === 'device') return source.name;
  if (source.kind === 'computer')
    return state?.computers.find((c) => c.installId === source.installId)?.name ?? 'Computer';
  const cp = state?.checkpoints.find((c) => c.id === source.id);
  return cp ? `Checkpoint ${checkpointDate(cp.checkpointAt)}` : 'Checkpoint';
}

function DriveStatusLine({ state }: { state: SyncPickerState }) {
  const { drive } = state;
  const line = (() => {
    switch (drive.status) {
      case 'off':
        return 'Drive sync not configured';
      case 'signedOut':
        return null;
      case 'syncing':
        return 'Syncing…';
      case 'ok':
        return drive.lastSyncAt ? `Synced ${relativeTime(drive.lastSyncAt)}` : 'Synced';
      case 'error':
        return `Sync failed: ${drive.message ?? 'unknown error'}`;
    }
  })();
  return (
    <div className="picker-status" data-testid="sync-status">
      {drive.status === 'signedOut' ? (
        <button
          type="button"
          className="toolbar-button"
          onClick={() => void sendSyncCommand({ cmd: 'signIn' }).catch(logError)}
        >
          Sign in to sync
        </button>
      ) : (
        line
      )}
      {drive.skipped.map((s) => (
        <div key={s} className="picker-skipped">
          Skipped {s}
        </div>
      ))}
    </div>
  );
}

/**
 * "This computer ▾": the header's dropdown for viewing another device's outline, read-only (Tab
 * Hammer computers through Drive, Chrome Sync devices through chrome.sessions) or a checkpoint.
 */
export function DevicePicker({ state, current, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Opening the picker pulls, and re-reads Chrome Sync's devices (they have no change event).
    void sendSyncCommand({ cmd: 'refresh' }).catch(logError);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (source: SyncSource | null) => {
    onPick(source);
    setOpen(false);
  };

  return (
    <div className="device-picker" ref={ref}>
      <button
        type="button"
        className="toolbar-button"
        data-testid="device-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {sourceLabel(state, current)} ▾
      </button>
      {open && state && (
        <div className="picker-menu" role="menu" aria-label="Devices">
          <div className="picker-self">
            {renaming ? (
              <input
                className="rename-field"
                aria-label="This computer's name"
                autoFocus
                defaultValue={state.self.name}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void sendSyncCommand({ cmd: 'rename', name: e.currentTarget.value }).catch(
                      logError,
                    );
                    setRenaming(false);
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRenaming(false);
                  }
                }}
                onBlur={() => setRenaming(false)}
              />
            ) : (
              <>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={current === null}
                  className="picker-item"
                  data-testid="picker-this-computer"
                  onClick={() => pick(null)}
                >
                  This computer <span className="picker-meta">{state.self.name}</span>
                </button>
                <button
                  type="button"
                  className="picker-rename"
                  aria-label="Rename this computer"
                  title="Rename this computer (its name on your other computers)"
                  onClick={() => setRenaming(true)}
                >
                  ✎
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            className="picker-item picker-sub"
            aria-expanded={showCheckpoints}
            data-testid="picker-checkpoints"
            onClick={() => setShowCheckpoints((s) => !s)}
          >
            Checkpoints… <span className="picker-meta">{state.checkpoints.length}</span>
          </button>
          {showCheckpoints &&
            (state.checkpoints.length === 0 ? (
              <div className="picker-empty picker-sub">No checkpoints yet</div>
            ) : (
              state.checkpoints.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current?.kind === 'checkpoint' && current.id === c.id}
                  className="picker-item picker-sub2"
                  data-testid="picker-checkpoint"
                  onClick={() => pick({ kind: 'checkpoint', id: c.id })}
                >
                  {checkpointDate(c.checkpointAt)}
                  {c.drastic && ' (before a big change)'}{' '}
                  <span className="picker-meta">{counts(c.windowCount, c.tabCount)}</span>
                </button>
              ))
            ))}
          {state.computers.length > 0 && <div className="picker-heading">Tab Hammer computers</div>}
          {state.computers.map((c) => (
            <button
              key={c.installId}
              type="button"
              role="menuitemradio"
              aria-checked={current?.kind === 'computer' && current.installId === c.installId}
              className="picker-item"
              data-testid="picker-computer"
              data-install-id={c.installId}
              disabled={c.problem !== undefined}
              onClick={() => pick({ kind: 'computer', installId: c.installId })}
            >
              {c.name}{' '}
              <span className="picker-meta">
                {c.problem === 'newer'
                  ? 'needs a newer Tab Hammer'
                  : c.problem
                    ? "can't be read"
                    : `synced ${relativeTime(c.updatedAt)}`}
              </span>
            </button>
          ))}
          {state.devices.length > 0 && <div className="picker-heading">Other devices</div>}
          {state.devices.map((d) => (
            <button
              key={d.name}
              type="button"
              role="menuitemradio"
              aria-checked={current?.kind === 'device' && current.name === d.name}
              className="picker-item"
              data-testid="picker-device"
              onClick={() => pick({ kind: 'device', name: d.name })}
            >
              {d.name} <span className="picker-meta">{counts(d.windowCount, d.tabCount)}</span>
            </button>
          ))}
          <DriveStatusLine state={state} />
        </div>
      )}
    </div>
  );
}

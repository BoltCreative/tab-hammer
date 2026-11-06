import { useEffect, useRef, useState } from 'react';
import type { SyncPickerState, SyncSource } from '../../shared/syncMessages';
import {
  hasDevicesPermission,
  requestDevicesPermission,
  subscribePermissions,
} from '../chrome/permissions';
import { relativeTime } from '../preview/relativeTime';
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
 * Offers the optional `sessions` permission Chrome Sync devices need, until it's granted (here, or
 * from chrome://extensions). Once granted, the worker reads them on the next refresh, which this
 * asks for.
 */
function DevicesPermissionRow() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const wasDenied = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      hasDevicesPermission()
        .then((g) => {
          if (cancelled) return;
          if (g && wasDenied.current) void sendSyncCommand({ cmd: 'refresh' }).catch(logError);
          wasDenied.current = !g;
          setGranted(g);
        })
        .catch(logError);
    };
    check();
    const unsubscribe = subscribePermissions(check);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (granted !== false) return null;
  return (
    <button
      type="button"
      className="picker-item"
      data-testid="picker-allow-devices"
      title="Lets Tab Hammer read the tabs Chrome Sync shows from your other signed-in devices"
      // Called directly in the click, nothing awaited first: Chrome only allows the request in a
      // user gesture. The grant itself is picked up by the subscription above.
      onClick={() => void requestDevicesPermission().catch(logError)}
    >
      Show your phones and other Chrome Sync devices…
    </button>
  );
}

/**
 * The devices panel, opened from the Actions menu ("Other devices…"): this computer (renameable),
 * its checkpoints, other Tab Hammer computers (through Drive), Chrome Sync devices (through
 * chrome.sessions, once its optional permission is granted), and Drive sync's status. Picking one shows its outline read-only in place of
 * this computer's. It sits in the header's banner area, above the outline.
 */
export function DevicesPanel({ state, current, onPick, onClose }: Props & { onClose: () => void }) {
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Opening the panel pulls, and re-reads Chrome Sync's devices (they have no change event).
    void sendSyncCommand({ cmd: 'refresh' }).catch(logError);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  const pick = (source: SyncSource | null) => {
    onPick(source);
    onClose();
  };

  return (
    <div
      className="devices-panel"
      ref={ref}
      role="region"
      aria-label="Other devices"
      data-testid="devices-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !renaming) onClose();
      }}
    >
      <div className="devices-panel-title">
        <strong>Devices</strong>
        <button type="button" className="toolbar-button" onClick={onClose}>
          Close
        </button>
      </div>
      {!state && <div className="picker-empty">Loading…</div>}
      {state && (
        <div className="picker-list">
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
                  aria-current={current === null || undefined}
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
                  aria-current={
                    (current?.kind === 'checkpoint' && current.id === c.id) || undefined
                  }
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
              aria-current={
                (current?.kind === 'computer' && current.installId === c.installId) || undefined
              }
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
          <DevicesPermissionRow />
          {state.devices.map((d) => (
            <button
              key={d.name}
              type="button"
              aria-current={(current?.kind === 'device' && current.name === d.name) || undefined}
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

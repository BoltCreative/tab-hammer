import { useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { SyncGroup, SyncTab, SyncWindow } from '../../model/sync/export';
import type {
  RemoteOutline as Remote,
  RestoreCounts,
  SyncPickerState,
  SyncSource,
} from '../../shared/syncMessages';
import { faviconUrl } from '../chrome/favicon';
import { RowToolbar, type RowAction } from '../components/RowToolbar';
import { relativeTime } from '../preview/relativeTime';
import { checkpointDate, sourceLabel } from './DevicePicker';
import { sendSyncCommand } from './syncClient';

// While another device is shown, its outline is pulled again this often (Chrome Sync devices have
// no change event, and other computers push on their own schedule).
const REFRESH_MS = 60_000;

interface Props {
  source: SyncSource | null; // null: this computer is shown, so nothing here
  state: SyncPickerState | null;
  onBack: () => void;
}

const OpenHereIcon = (
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
    <path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v4h-9v-9h4" />
  </svg>
);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What Restore all did, in the user's words. */
function restoreText({ added, untrashed }: RestoreCounts): string {
  if (added === 0 && untrashed === 0) return 'This computer already has every window';
  const bottom = "at the bottom of this computer's outline";
  if (untrashed === 0) return `Restored ${plural(added, 'window')}, hibernated, ${bottom}`;
  if (added === 0)
    return `Restored ${plural(untrashed, 'window')} from Recently closed, hibernated`;
  return `Restored ${plural(added + untrashed, 'window')}, hibernated: ${added} ${bottom}, ${untrashed} from Recently closed`;
}

/** Something to show in the banner: a result, a question, or an error. */
type Notice =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'retire'; text: string; installId: string };

/**
 * Another device's outline, or a checkpoint, read-only, in place of this computer's: a banner for
 * the fixed header (naming it, with Back, Restore all, Forget) and the list for the scrolling area.
 * Open here copies a window, group, or tab to this computer; Restore all brings in every window it
 * lacks, hibernated; Forget drops another computer's file from Drive.
 */
export function useRemoteOutline({ source, state, onBack }: Props): {
  banner: ReactNode;
  list: ReactNode;
} {
  // Each piece of state remembers which source it belongs to, so switching sources shows nothing
  // stale while the new outline loads.
  const key = source === null ? null : JSON.stringify(source);
  const [loaded, setLoaded] = useState<{ key: string; remote?: Remote; error?: string } | null>(
    null,
  );
  const [noticeOf, setNotice] = useState<{ key: string; notice: Notice | null } | null>(null);
  const [busy, setBusy] = useState(false);

  // Refetched whenever the picker state changes (a pull downloaded a newer file, say).
  const version =
    source?.kind === 'computer'
      ? state?.computers.find((c) => c.installId === source.installId)?.updatedAt
      : source?.kind === 'device'
        ? state?.devices.find((d) => d.name === source.name)?.updatedAt
        : undefined;
  useEffect(() => {
    if (key === null) return;
    let stale = false;
    sendSyncCommand<Remote>({ cmd: 'outlineOf', source: JSON.parse(key) as SyncSource }).then(
      (remote) => {
        if (!stale) setLoaded({ key, remote });
      },
      (err: unknown) => {
        if (!stale) setLoaded({ key, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      stale = true;
    };
  }, [key, version]);

  const kind = source?.kind;
  useEffect(() => {
    if (kind === undefined || kind === 'checkpoint') return;
    const timer = setInterval(() => {
      void sendSyncCommand({ cmd: 'refresh' }).catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [kind]);

  if (source === null || key === null) return { banner: null, list: null };
  const remote = loaded?.key === key ? (loaded.remote ?? null) : null;
  const error = loaded?.key === key ? (loaded.error ?? null) : null;
  const notice = noticeOf?.key === key ? noticeOf.notice : null;

  const act = (run: () => Promise<Notice | null>) => {
    setBusy(true);
    run()
      .then(
        (n) => setNotice({ key, notice: n }),
        (err: unknown) =>
          setNotice({
            key,
            notice: { kind: 'error', text: err instanceof Error ? err.message : String(err) },
          }),
      )
      .finally(() => setBusy(false));
  };
  const openHere = (rowId: string) =>
    act(async () => {
      await sendSyncCommand({ cmd: 'openHere', source, rowId });
      return { kind: 'info', text: 'Opened on this computer' };
    });
  const restoreAll = () =>
    act(async () => {
      const counts = await sendSyncCommand<RestoreCounts>({ cmd: 'restoreAll', source });
      const text = restoreText(counts);
      const added = counts.added;
      // Taking over a replaced computer: offer to retire its file.
      if (source.kind === 'computer' && added > 0)
        return { kind: 'retire', text, installId: source.installId };
      return { kind: 'info', text };
    });
  const forget = (installId: string) =>
    act(async () => {
      await sendSyncCommand({ cmd: 'forget', installId });
      onBack();
      return null;
    });

  const title = sourceLabel(state, source);
  const windows = remote?.windows ?? [];
  const tabTotal = windows.reduce((n, w) => n + w.tabs.length, 0);
  const subtitle = remote
    ? remote.checkpointAt !== undefined
      ? `Checkpoint of ${checkpointDate(remote.checkpointAt)}, ${plural(windows.length, 'window')}, ${plural(tabTotal, 'tab')}`
      : `${remote.updatedAt ? `synced ${relativeTime(remote.updatedAt)}, ` : ''}${plural(windows.length, 'window')}, ${plural(tabTotal, 'tab')}`
    : '';
  const canRestore = source.kind !== 'device';

  const banner = (
    <div
      className="remote-banner"
      role="region"
      aria-label={`${title}, read-only`}
      data-testid="remote-banner"
    >
      <div className="remote-banner-text">
        <strong>{title}</strong> <span className="picker-meta">read-only · {subtitle}</span>
      </div>
      <div className="remote-banner-actions">
        <button type="button" className="toolbar-button" onClick={onBack}>
          Back to this computer
        </button>
        {canRestore && (
          <button
            type="button"
            className="toolbar-button"
            disabled={busy || windows.length === 0}
            title="Bring in every window this computer doesn't have, hibernated"
            onClick={restoreAll}
          >
            Restore all
          </button>
        )}
        {source.kind === 'computer' && (
          <button
            type="button"
            className="toolbar-button"
            disabled={busy}
            title="Delete this computer's outline from Drive. If it's still in use, it uploads it again."
            onClick={() => forget(source.installId)}
          >
            Forget
          </button>
        )}
      </div>
      {notice && (
        <div className={`remote-notice ${notice.kind}`} role="status">
          {notice.text}
          {notice.kind === 'retire' && (
            <>
              {' '}
              Retire {title}&apos;s file now that this computer has taken over?{' '}
              <button
                type="button"
                className="toolbar-button"
                onClick={() => forget(notice.installId)}
              >
                Retire
              </button>{' '}
              <button type="button" className="toolbar-button" onClick={() => setNotice(null)}>
                Keep
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
  const list = (
    <main className="outline remote-outline" aria-label={`${title}'s windows and tabs`}>
      {error && <p className="outline-empty">{error}</p>}
      {remote && windows.length === 0 && <p className="outline-empty">No windows</p>}
      {windows.map((w, i) => (
        <RemoteWindow key={w.id} win={w} label={w.name ?? `Window ${i + 1}`} openHere={openHere} />
      ))}
    </main>
  );
  return { banner, list };
}

function onEnter(run: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    run();
  };
}

function RemoteWindow({
  win,
  label,
  openHere,
}: {
  win: SyncWindow;
  label: string;
  openHere: (rowId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const groups = new Map<string, SyncGroup>(win.groups.map((g) => [g.id, g]));
  const actions: RowAction[] = [
    { label: 'Open here', icon: OpenHereIcon, onClick: () => openHere(win.id) },
  ];
  // Runs of consecutive tabs in one group, as in this computer's outline.
  const runs: { group?: SyncGroup; tabs: SyncTab[] }[] = [];
  for (const t of win.tabs) {
    const g = t.groupId === undefined ? undefined : groups.get(t.groupId);
    const last = runs[runs.length - 1];
    if (last && last.group === g && g !== undefined) last.tabs.push(t);
    else runs.push({ group: g, tabs: [t] });
  }
  const hibernated = win.state !== 'live';
  return (
    <section className="card" data-testid="remote-window" data-row-id={win.id}>
      <div
        className={hibernated ? 'row window-header hibernated' : 'row window-header'}
        tabIndex={0}
        onDoubleClick={() => openHere(win.id)}
        onKeyDown={onEnter(() => openHere(win.id))}
      >
        <button
          type="button"
          className="twisty"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="title">{label}</span>
        <span className="count">{plural(win.tabs.length, 'tab')}</span>
        <RowToolbar actions={actions} />
      </div>
      {!collapsed &&
        runs.map((r) =>
          r.group ? (
            <div
              key={`${r.group.id}:${r.tabs[0]!.id}`}
              style={{ '--group-color': `var(--group-${r.group.color})` } as CSSProperties}
            >
              <div
                className={hibernated ? 'row group-header hibernated' : 'row group-header'}
                tabIndex={0}
                onDoubleClick={() => openHere(r.group!.id)}
                onKeyDown={onEnter(() => openHere(r.group!.id))}
              >
                <span className="group-dot" />
                <span className="title">{r.group.title || 'Untitled group'}</span>
                <RowToolbar
                  actions={[
                    {
                      label: 'Open here',
                      icon: OpenHereIcon,
                      onClick: () => openHere(r.group!.id),
                    },
                  ]}
                />
              </div>
              <div className="group-tabs">
                {r.tabs.map((t) => (
                  <RemoteTab key={t.id} tab={t} hibernated={hibernated} openHere={openHere} />
                ))}
              </div>
            </div>
          ) : (
            <RemoteTab
              key={r.tabs[0]!.id}
              tab={r.tabs[0]!}
              hibernated={hibernated}
              openHere={openHere}
            />
          ),
        )}
    </section>
  );
}

function RemoteTab({
  tab,
  hibernated,
  openHere,
}: {
  tab: SyncTab;
  hibernated: boolean;
  openHere: (rowId: string) => void;
}) {
  return (
    <div
      className={hibernated ? 'row tab hibernated' : 'row tab'}
      data-testid="remote-tab"
      data-row-id={tab.id}
      tabIndex={0}
      aria-label={tab.url && tab.url !== tab.title ? `${tab.title}, ${tab.url}` : tab.title}
      onDoubleClick={() => openHere(tab.id)}
      onKeyDown={onEnter(() => openHere(tab.id))}
    >
      {tab.url ? (
        <img className="favicon" src={faviconUrl(tab.url)} alt="" />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title || tab.url}</span>
      <RowToolbar
        actions={[{ label: 'Open here', icon: OpenHereIcon, onClick: () => openHere(tab.id) }]}
      />
    </div>
  );
}

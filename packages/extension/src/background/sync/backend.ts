// Where sync files live. Production is Drive's hidden app-data folder (driveBackend.ts); unit tests
// use memoryBackend.ts, and e2e points the Drive backend at a fake Drive served by the test.

export interface RemoteFile {
  name: string;
  modifiedTime: number; // ms; changes whenever the file is written
}

/** Files by name. Every call may throw: offline, signed out (AuthError), or a server error. */
export interface SyncBackend {
  list(): Promise<RemoteFile[]>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<RemoteFile>;
  remove(name: string): Promise<void>; // no error if it's already gone
}

/** No usable sign-in: the Chrome profile isn't signed in, or the user hasn't granted access. */
export class AuthError extends Error {
  override name = 'AuthError';
}

/** The file isn't there (read only; remove ignores it). */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export const outlineFileName = (installId: string) => `outline-${installId}.json`;
export const checkpointFileName = (installId: string, at: number) =>
  `checkpoint-${installId}-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`;

const OUTLINE_RE = /^outline-(.+)\.json$/;
const CHECKPOINT_RE = /^checkpoint-(.+)-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.json$/;

/** The install ID an outline file belongs to, or undefined for any other name. */
export function parseOutlineName(name: string): string | undefined {
  return CHECKPOINT_RE.test(name) ? undefined : OUTLINE_RE.exec(name)?.[1];
}

/** A checkpoint file's install ID and time, or undefined for any other name. */
export function parseCheckpointName(name: string): { installId: string; at: number } | undefined {
  const m = CHECKPOINT_RE.exec(name);
  if (!m) return undefined;
  const [date, time] = m[2]!.split('T') as [string, string];
  const [h, min, s, ms] = time.slice(0, -1).split('-');
  const at = Date.parse(`${date}T${h}:${min}:${s}.${ms}Z`);
  return Number.isNaN(at) ? undefined : { installId: m[1]!, at };
}

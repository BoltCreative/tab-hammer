// The SyncBackend on Google Drive's REST API, in the hidden app-data folder (scope drive.appdata).
// Files are addressed by name; their Drive IDs are cached from listings and lookups.
import { AuthError, NotFoundError, type RemoteFile, type SyncBackend } from './backend';

export const GOOGLE_API_BASE = 'https://www.googleapis.com';

export interface DriveDeps {
  fetch: typeof fetch;
  /** An access token; throws AuthError when there's none to be had without asking the user. */
  token: () => Promise<string>;
  /** Drops a token Drive rejected from Chrome's cache, so the next `token()` fetches a fresh one. */
  dropToken: (token: string) => Promise<void>;
  apiBase?: string; // e2e points this at a fake Drive
}

export class DriveError extends Error {
  override name = 'DriveError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
}

const FIELDS = 'id,name,modifiedTime';
const BOUNDARY = 'tab-hammer-sync-boundary';

export function createDriveBackend(deps: DriveDeps): SyncBackend {
  const base = deps.apiBase ?? GOOGLE_API_BASE;
  const filesUrl = `${base}/drive/v3/files`;
  const uploadUrl = `${base}/upload/drive/v3/files`;
  const ids = new Map<string, string>(); // file name -> Drive ID

  /** One request with a bearer token; a 401 drops the token and retries once with a fresh one. */
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await deps.token();
      const res = await deps.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
      });
      if (res.status !== 401) return res;
      await deps.dropToken(token);
      if (attempt === 1) throw new AuthError('Drive rejected the sign-in');
    }
  }

  async function ok(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    throw new DriveError(res.status, `Drive ${what} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const toRemote = (f: DriveFile): RemoteFile => ({
    name: f.name,
    modifiedTime: Date.parse(f.modifiedTime),
  });

  /** The Drive ID of `name`, from the cache or a lookup; undefined if there's no such file. */
  async function idOf(name: string): Promise<string | undefined> {
    const cached = ids.get(name);
    if (cached !== undefined) return cached;
    const q = `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const params = new URLSearchParams({ spaces: 'appDataFolder', q, fields: `files(${FIELDS})` });
    const res = await ok(await request(`${filesUrl}?${params}`), 'lookup');
    const { files } = (await res.json()) as { files: DriveFile[] };
    const newest = files.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime))[0];
    if (newest) ids.set(name, newest.id);
    return newest?.id;
  }

  async function create(name: string, content: string): Promise<RemoteFile> {
    const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
    const body =
      `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${BOUNDARY}--`;
    const res = await ok(
      await request(`${uploadUrl}?uploadType=multipart&fields=${FIELDS}`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${BOUNDARY}` },
        body,
      }),
      'create',
    );
    const f = (await res.json()) as DriveFile;
    ids.set(name, f.id);
    return toRemote(f);
  }

  return {
    async list() {
      const out: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          spaces: 'appDataFolder',
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: '1000',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await ok(await request(`${filesUrl}?${params}`), 'list');
        const page = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
        out.push(...page.files);
        pageToken = page.nextPageToken;
      } while (pageToken);
      // Two files with one name (two creates that raced): the newest wins.
      out.sort((a, b) => Date.parse(a.modifiedTime) - Date.parse(b.modifiedTime));
      const byName = new Map(out.map((f) => [f.name, f]));
      ids.clear();
      for (const [name, f] of byName) ids.set(name, f.id);
      return [...byName.values()].map(toRemote);
    },

    async read(name) {
      const id = await idOf(name);
      if (id === undefined) throw new NotFoundError(name);
      const res = await request(`${filesUrl}/${id}?alt=media`);
      if (res.status === 404) {
        ids.delete(name);
        throw new NotFoundError(name);
      }
      return (await ok(res, 'read')).text();
    },

    async write(name, content) {
      const id = await idOf(name);
      if (id === undefined) return create(name, content);
      const res = await request(`${uploadUrl}/${id}?uploadType=media&fields=${FIELDS}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      });
      if (res.status === 404) {
        ids.delete(name); // deleted elsewhere (Forget on another computer)
        return create(name, content);
      }
      return toRemote((await (await ok(res, 'update')).json()) as DriveFile);
    },

    async remove(name) {
      const id = await idOf(name);
      if (id === undefined) return;
      const res = await request(`${filesUrl}/${id}`, { method: 'DELETE' });
      ids.delete(name);
      if (res.status !== 404) await ok(res, 'delete');
    },
  };
}

// A fake of the slice of Google Drive's REST API the Drive backend uses (the app-data folder: list,
// lookup by name, download, multipart create, media update, delete). The Drive backend's unit tests
// run against it in process, and the e2e suite serves it over HTTP, so sync tests never reach
// Google. Only requests with an accepted bearer token get through; anything else is a 401.

export interface FakeDriveRequest {
  method: string;
  url: string; // path and query
  headers: Record<string, string | undefined>; // lower-case names
  body: string;
}

export interface FakeDriveResponse {
  status: number;
  body: string;
  contentType?: string;
}

interface StoredFile {
  id: string;
  name: string;
  content: string;
  modifiedTime: string;
}

export function createFakeDrive(opts: { tokens?: string[]; pageSize?: number } = {}) {
  const tokens = new Set(opts.tokens ?? ['test-token']);
  const files = new Map<string, StoredFile>(); // by ID
  let nextId = 1;
  let lastTime = 0;
  const requests: { method: string; path: string }[] = [];

  const stamp = () => {
    lastTime = Math.max(Date.now(), lastTime + 1);
    return new Date(lastTime).toISOString();
  };
  const json = (status: number, v: unknown): FakeDriveResponse => ({
    status,
    body: JSON.stringify(v),
    contentType: 'application/json',
  });
  const meta = (f: StoredFile) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });

  function handle(req: FakeDriveRequest): FakeDriveResponse {
    const url = new URL(req.url, 'http://fake.drive');
    requests.push({ method: req.method, path: url.pathname });
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7)))
      return json(401, { error: { code: 401, message: 'Invalid Credentials' } });

    const p = url.pathname;
    const q = url.searchParams;
    if (req.method === 'GET' && p === '/drive/v3/files') {
      if (q.get('spaces') !== 'appDataFolder') return json(400, { error: 'spaces' });
      let all = [...files.values()];
      const query = q.get('q');
      if (query) {
        const m = /^name = '((?:[^'\\]|\\.)*)'$/.exec(query);
        if (!m) return json(400, { error: `unsupported q: ${query}` });
        const name = m[1]!.replace(/\\(.)/g, '$1');
        all = all.filter((f) => f.name === name);
      }
      const size = Math.min(Number(q.get('pageSize') ?? 100), opts.pageSize ?? Infinity);
      const start = Number(q.get('pageToken') ?? 0);
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      return json(200, {
        files: page.map(meta),
        ...(more && { nextPageToken: String(start + size) }),
      });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (one) {
      const f = files.get(one[1]!);
      if (!f) return json(404, { error: { code: 404 } });
      if (req.method === 'GET' && q.get('alt') === 'media')
        return { status: 200, body: f.content, contentType: 'application/json' };
      if (req.method === 'DELETE') {
        files.delete(f.id);
        return { status: 204, body: '' };
      }
    }
    if (req.method === 'POST' && p === '/upload/drive/v3/files') {
      if (q.get('uploadType') !== 'multipart') return json(400, { error: 'uploadType' });
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      if (!boundary) return json(400, { error: 'no boundary' });
      const parts = req.body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
      if (parts.length !== 2) return json(400, { error: 'expected 2 parts' });
      const m = JSON.parse(parts[0]!) as { name: string; parents?: string[] };
      if (JSON.stringify(m.parents) !== '["appDataFolder"]') return json(400, { error: 'parents' });
      const f: StoredFile = {
        id: `f${nextId++}`,
        name: m.name,
        content: parts[1]!,
        modifiedTime: stamp(),
      };
      files.set(f.id, f);
      return json(200, meta(f));
    }
    const upd = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (upd && req.method === 'PATCH') {
      const f = files.get(upd[1]!);
      if (!f) return json(404, { error: { code: 404 } });
      if (q.get('uploadType') !== 'media') return json(400, { error: 'uploadType' });
      f.content = req.body;
      f.modifiedTime = stamp();
      return json(200, meta(f));
    }
    return json(404, { error: `no route ${req.method} ${p}` });
  }

  return {
    handle,
    requests,
    tokens,
    /** Current files by name (the newest, if a name is repeated). */
    byName(): Map<string, string> {
      const out = new Map<string, string>();
      for (const f of [...files.values()].sort((a, b) =>
        a.modifiedTime.localeCompare(b.modifiedTime),
      ))
        out.set(f.name, f.content);
      return out;
    },
    /** Puts a file in place as if another client wrote it. */
    put(name: string, content: string) {
      const f: StoredFile = { id: `f${nextId++}`, name, content, modifiedTime: stamp() };
      files.set(f.id, f);
    },
    /** A `fetch` that answers from this fake, for in-process tests. */
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      const res = handle({
        method: init.method ?? 'GET',
        url: u.pathname + u.search,
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body: typeof init.body === 'string' ? init.body : '',
      });
      return new Response(res.status === 204 ? null : res.body, {
        status: res.status,
        headers: res.contentType ? { 'content-type': res.contentType } : {},
      });
    }) as typeof fetch,
  };
}

export type FakeDrive = ReturnType<typeof createFakeDrive>;

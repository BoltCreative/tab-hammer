// The Chrome Web Store client against a stand-in store: no real credentials reach these tests, so
// they pin the requests the API v2 docs describe and the answers CI acts on.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Cws, CwsError, SCOPE, type ItemStatus } from '../cwsClient.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  client_email: 'ci@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const ITEM = 'https://cws.test/v2/publishers/pub-1/items/item-1';

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A fake store: answers by "METHOD url", in order for repeated calls; records every request. */
function fakeStore(routes: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    const route = `${method} ${url}`;
    if (url === 'https://token.test')
      return Response.json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    const queue = routes[route];
    if (!queue?.length) throw new Error(`unexpected ${route}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next instanceof Response ? next : Response.json(next);
  }) as typeof globalThis.fetch;
  const cws = new Cws({
    publisherId: 'pub-1',
    itemId: 'item-1',
    credentials: KEY,
    apiBase: 'https://cws.test',
    tokenUrl: 'https://token.test',
    fetch,
    pollMs: 0,
  });
  return { cws, calls };
}

const idle: ItemStatus = {
  publishedItemRevisionStatus: {
    state: 'PUBLISHED',
    distributionChannels: [{ crxVersion: '0.1.0.40', deployPercentage: 100 }],
  },
};
const pending: ItemStatus = {
  submittedItemRevisionStatus: {
    state: 'PENDING_REVIEW',
    distributionChannels: [{ crxVersion: '0.1.0.41' }],
  },
};

describe('Chrome Web Store client', () => {
  it('signs in as the service account with a JWT Google can verify', async () => {
    const { cws, calls } = fakeStore({ [`GET ${ITEM}:fetchStatus`]: [idle] });
    await cws.status();

    const form = new URLSearchParams(calls[0]!.body as URLSearchParams);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const c = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(c).toMatchObject({ iss: KEY.client_email, scope: SCOPE, aud: 'https://token.test' });
    expect(c.exp - c.iat).toBe(3600);
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(valid).toBe(true);
    expect(calls[1]!.headers.authorization).toBe('Bearer tok');
  });

  it('uploads the zip to the media endpoint as the draft', async () => {
    const { cws, calls } = fakeStore({
      [`GET ${ITEM}:fetchStatus`]: [idle],
      [`POST https://cws.test/upload/v2/publishers/pub-1/items/item-1:upload`]: [
        { uploadState: 'SUCCEEDED', crxVersion: '0.1.0.42' },
      ],
    });
    const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
    expect(await cws.upload(zip)).toEqual({
      done: true,
      message: 'Uploaded 0.1.0.42 as the store draft.',
    });
    const upload = calls.find((c) => c.url.includes(':upload'))!;
    expect(upload.body).toBe(zip);
    expect(upload.headers['content-type']).toBe('application/zip');
  });

  it('waits on an upload the store is still processing', async () => {
    const { cws } = fakeStore({
      [`GET ${ITEM}:fetchStatus`]: [
        idle,
        { ...idle, lastAsyncUploadState: 'IN_PROGRESS' },
        { ...idle, lastAsyncUploadState: 'SUCCEEDED' },
      ],
      [`POST https://cws.test/upload/v2/publishers/pub-1/items/item-1:upload`]: [
        { uploadState: 'IN_PROGRESS' },
      ],
    });
    expect((await cws.upload(new Uint8Array())).done).toBe(true);
  });

  it('reports a failed upload, and the store’s own error message', async () => {
    const failed = fakeStore({
      [`GET ${ITEM}:fetchStatus`]: [idle],
      [`POST https://cws.test/upload/v2/publishers/pub-1/items/item-1:upload`]: [
        { uploadState: 'FAILED' },
      ],
    });
    await expect(failed.cws.upload(new Uint8Array())).rejects.toThrow(/upload state FAILED/);

    const refused = fakeStore({
      [`GET ${ITEM}:fetchStatus`]: [idle],
      [`POST https://cws.test/upload/v2/publishers/pub-1/items/item-1:upload`]: [
        Response.json(
          { error: { code: 400, message: 'The version must be higher than 0.1.0.42.' } },
          { status: 400 },
        ),
      ],
    });
    const err = await refused.cws.upload(new Uint8Array()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CwsError);
    expect((err as Error).message).toMatch(/400: The version must be higher than 0\.1\.0\.42\./);
  });

  it('leaves the draft alone while a review is pending', async () => {
    const { cws, calls } = fakeStore({ [`GET ${ITEM}:fetchStatus`]: [pending] });
    const outcome = await cws.upload(new Uint8Array());
    expect(outcome.done).toBe(false);
    expect(outcome.message).toMatch(/0\.1\.0\.41 is waiting on review/);
    expect(calls.some((c) => c.url.includes(':upload'))).toBe(false);
  });

  it('submits the draft for review', async () => {
    const { cws, calls } = fakeStore({
      [`GET ${ITEM}:fetchStatus`]: [idle],
      [`POST ${ITEM}:publish`]: [{ state: 'PENDING_REVIEW', itemId: 'item-1' }],
    });
    expect(await cws.publish()).toEqual({
      done: true,
      message: 'Submitted the draft for review (state PENDING_REVIEW).',
    });
    expect(calls.at(-1)!.method).toBe('POST');
  });

  it('refuses to submit while a review is already pending, naming its version', async () => {
    const { cws, calls } = fakeStore({ [`GET ${ITEM}:fetchStatus`]: [pending] });
    const outcome = await cws.publish();
    expect(outcome.done).toBe(false);
    expect(outcome.message).toMatch(/A review is already pending, for version 0\.1\.0\.41/);
    expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
  });

  it('signs in with a refresh token when there is no service account', async () => {
    const calls: Call[] = [];
    const cws = new Cws({
      publisherId: 'pub-1',
      itemId: 'item-1',
      credentials: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' },
      tokenUrl: 'https://token.test',
      apiBase: 'https://cws.test',
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? 'GET', url, headers: {}, body: init.body });
        return Response.json(url === 'https://token.test' ? { access_token: 'tok' } : idle);
      }) as typeof fetch,
    });
    await cws.status();
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body as URLSearchParams))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'sec',
      refresh_token: 'rt',
    });
  });
});

// A small client for the Chrome Web Store API v2 (https://developer.chrome.com/docs/webstore/api):
// upload a package to the item's draft, and submit the draft for review. CI runs it through
// scripts/cws.ts (.github/workflows/release.yml). Plain Node: fetch and node:crypto.
import { createSign } from 'node:crypto';

export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API_BASE = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** A service account's JSON key (the account is added to the publisher in the store dashboard). */
export type ServiceAccountKey = { client_email: string; private_key: string };
/** An OAuth client and a refresh token for a Google account that owns the item. */
export type RefreshTokenCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type CwsConfig = {
  publisherId: string;
  itemId: string;
  credentials: ServiceAccountKey | RefreshTokenCredentials;
  apiBase?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  /** How long to wait between status checks while the store processes an upload. */
  pollMs?: number;
  /** How many status checks before giving up on an upload the store is still processing. */
  pollLimit?: number;
};

export type ItemState =
  | 'ITEM_STATE_UNSPECIFIED'
  | 'PENDING_REVIEW'
  | 'STAGED'
  | 'PUBLISHED'
  | 'PUBLISHED_TO_TESTERS'
  | 'REJECTED'
  | 'CANCELLED';
type UploadState =
  'UPLOAD_STATE_UNSPECIFIED' | 'SUCCEEDED' | 'IN_PROGRESS' | 'FAILED' | 'NOT_FOUND';
type RevisionStatus = {
  state?: ItemState;
  distributionChannels?: { crxVersion?: string; deployPercentage?: number }[];
};
export type ItemStatus = {
  submittedItemRevisionStatus?: RevisionStatus;
  publishedItemRevisionStatus?: RevisionStatus;
  lastAsyncUploadState?: UploadState;
  takenDown?: boolean;
  warned?: boolean;
};

export type Outcome = { done: boolean; message: string };

export class CwsError extends Error {}

const versionOf = (r?: RevisionStatus) =>
  r?.distributionChannels?.map((c) => c.crxVersion).find(Boolean) ?? 'unknown version';

/** The submission waiting on review, if any: the store won't take a new upload or submission then. */
export function pendingReview(status: ItemStatus): string | null {
  const s = status.submittedItemRevisionStatus;
  return s?.state === 'PENDING_REVIEW' ? versionOf(s) : null;
}

const base64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The signed JWT a service account trades for an access token (OAuth 2.0 JWT bearer grant). */
export function serviceAccountAssertion(key: ServiceAccountKey, aud: string, now: number): string {
  const iat = Math.floor(now / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }),
  )}`;
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  } catch (e) {
    throw new CwsError(`The service account's private_key can't sign (${(e as Error).message}).`);
  }
  return `${unsigned}.${base64url(signature)}`;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    // API errors: {error: {message}}; OAuth errors: {error, error_description}.
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      error_description?: string;
    };
    const e = parsed.error;
    const message =
      typeof e === 'string' ? [e, parsed.error_description].filter(Boolean).join(': ') : e?.message;
    if (message) return `${res.status}: ${message}`;
  } catch {
    // not JSON: fall through to the raw body
  }
  return `${res.status}: ${body.slice(0, 500)}`;
}

export class Cws {
  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly fetch: typeof fetch;
  private readonly config: CwsConfig;
  private token: string | undefined;

  // No parameter properties: CI runs this file on Node's type stripping, which can't.
  constructor(config: CwsConfig) {
    this.config = config;
    this.api = config.apiBase ?? API_BASE;
    this.tokenUrl = config.tokenUrl ?? TOKEN_URL;
    this.fetch = config.fetch ?? fetch;
  }

  private get item() {
    return `publishers/${encodeURIComponent(this.config.publisherId)}/items/${encodeURIComponent(this.config.itemId)}`;
  }

  async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const c = this.config.credentials;
    const form =
      'private_key' in c
        ? new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: serviceAccountAssertion(c, this.tokenUrl, Date.now()),
          })
        : new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: c.clientId,
            client_secret: c.clientSecret,
            refresh_token: c.refreshToken,
          });
    const res = await this.fetch(this.tokenUrl, { method: 'POST', body: form });
    if (!res.ok) throw new CwsError(`Google sign-in failed (${await errorText(res)})`);
    this.token = ((await res.json()) as { access_token: string }).access_token;
    return this.token;
  }

  private async call<T>(method: string, url: string, body?: BodyInit, type?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}` };
    if (type) headers['content-type'] = type;
    const res = await this.fetch(url, { method, headers, body });
    if (!res.ok) throw new CwsError(`${method} ${url} failed (${await errorText(res)})`);
    return (await res.json()) as T;
  }

  status(): Promise<ItemStatus> {
    return this.call('GET', `${this.api}/v2/${this.item}:fetchStatus`);
  }

  /** Replaces the item's draft with `zip`, waiting while the store processes it. */
  async upload(zip: Uint8Array): Promise<Outcome> {
    const pending = pendingReview(await this.status());
    if (pending)
      return {
        done: false,
        message:
          `Not uploaded: version ${pending} is waiting on review, and the store takes no new ` +
          `package until that review ends. Run the Release workflow again afterwards, or ` +
          `cancel the review in the developer dashboard first.`,
      };

    const res = await this.call<{ uploadState?: UploadState; crxVersion?: string }>(
      'POST',
      `${this.api}/upload/v2/${this.item}:upload`,
      zip as BodyInit,
      'application/zip',
    );
    let state = res.uploadState;
    for (let i = 0; state === 'IN_PROGRESS' && i < (this.config.pollLimit ?? 60); i++) {
      await new Promise((r) => setTimeout(r, this.config.pollMs ?? 5000));
      state = (await this.status()).lastAsyncUploadState;
    }
    if (state === 'SUCCEEDED')
      return {
        done: true,
        message: `Uploaded ${res.crxVersion ?? 'the package'} as the store draft.`,
      };
    if (state === 'IN_PROGRESS')
      throw new CwsError(
        'The store is still processing the upload; check the developer dashboard.',
      );
    throw new CwsError(`The store rejected the upload (upload state ${state ?? 'missing'}).`);
  }

  /**
   * Submits the current draft for review. Given the draft's `version`, a submission or release
   * that already holds it counts as done, so running Release again changes nothing.
   */
  async publish(version?: string): Promise<Outcome> {
    const status = await this.status();
    const pending = pendingReview(status);
    if (version && pending === version)
      return { done: true, message: `${version} is already submitted and waiting on review.` };
    if (version && versionOf(status.publishedItemRevisionStatus) === version)
      return { done: true, message: `${version} is already published.` };
    if (pending)
      return {
        done: false,
        message:
          `A review is already pending, for version ${pending}. Nothing was submitted: wait for ` +
          `that review to finish, or cancel it in the developer dashboard and run Release again.`,
      };
    const res = await this.call<{ state?: ItemState }>(
      'POST',
      `${this.api}/v2/${this.item}:publish`,
    );
    return {
      done: true,
      message: `Submitted the draft for review (state ${res.state ?? 'unknown'}).`,
    };
  }
}

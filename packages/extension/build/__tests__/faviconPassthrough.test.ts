import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { letFaviconsBypassDevProxy } from '../faviconPassthrough';

// Runs crxjs's real dev service-worker client (from the installed package) with the patch applied,
// so a crxjs upgrade that changes the proxy shows up here rather than as grey favicons in dev.
function installedCrxWorkerClient(): string {
  const require = createRequire(import.meta.url);
  const pkgDir = require.resolve('@crxjs/vite-plugin/package.json').replace(/package\.json$/, '');
  const source = readFileSync(`${pkgDir}dist/index.mjs`, 'utf8');
  const literal = /var hmr_client_worker_default = ("(?:[^"\\]|\\.)*");/.exec(source)?.[1];
  if (!literal) throw new Error('crxjs worker client not found in @crxjs/vite-plugin');
  return JSON.parse(literal) as string;
}

const EXT_ID = 'lpnkidobhhpmokecbinbliomjehmndia';

function runWorkerClient(code: string) {
  let fetchListener: ((e: unknown) => void) | undefined;
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'fetch') fetchListener = fn;
    },
  };
  const chrome = {
    runtime: {
      id: EXT_ID,
      onConnect: { addListener() {} },
      onConnectExternal: { addListener() {} },
    },
  };
  class FakeSocket {
    addEventListener() {}
  }
  // Node reports origin "null" for chrome-extension: URLs; Chrome reports scheme://host.
  class ChromeURL extends URL {
    override get origin() {
      return `${this.protocol}//${this.host}`;
    }
  }
  const defines: Record<string, string> = {
    __CRX_HMR_TOKEN__: '"t"',
    __SERVER_PROTO__: '"http"',
    __SERVER_PORT__: '"5174"',
    __HMR_PROTOCOL__: '"ws"',
    __HMR_TOKEN__: '"t"',
    __HMR_HOSTNAME__: '"localhost"',
    __HMR_PORT__: '"5174"',
    __HMR_TIMEOUT__: '30000',
    __BASE__: '"/"',
    __LIVE_RELOAD__: 'true',
  };
  const body = Object.entries(defines).reduce((c, [k, v]) => c.split(k).join(v), code);
  new Function('self', 'chrome', 'WebSocket', 'URL', 'fetch', 'location', 'console', body)(
    self,
    chrome,
    FakeSocket,
    ChromeURL,
    () => new Promise(() => {}), // the proxied request never needs to reach a dev server
    { protocol: 'chrome-extension:', hostname: EXT_ID },
    { log() {}, error() {} },
  );
  if (!fetchListener) throw new Error('worker client registered no fetch listener');
  const listener = fetchListener;
  return (url: string) => {
    const respondWith = vi.fn();
    listener({ request: new Request(url), respondWith });
    return respondWith.mock.calls.length > 0;
  };
}

describe('letFaviconsBypassDevProxy', () => {
  it("leaves Chrome's _favicon endpoint to Chrome while still proxying other extension files", () => {
    const proxies = runWorkerClient(letFaviconsBypassDevProxy(installedCrxWorkerClient()));
    expect(
      proxies(`chrome-extension://${EXT_ID}/_favicon/?pageUrl=https%3A%2F%2Fexample.com&size=16`),
    ).toBe(false);
    expect(proxies(`chrome-extension://${EXT_ID}/src/view/main.tsx`)).toBe(true);
  });

  it('the unpatched client proxies _favicon (the bug)', () => {
    const proxies = runWorkerClient(installedCrxWorkerClient());
    expect(proxies(`chrome-extension://${EXT_ID}/_favicon/?pageUrl=x&size=16`)).toBe(true);
  });

  it('throws when the crxjs client no longer matches', () => {
    expect(() => letFaviconsBypassDevProxy('self.addEventListener("fetch", () => {})')).toThrow(
      /favicon-passthrough/,
    );
  });
});

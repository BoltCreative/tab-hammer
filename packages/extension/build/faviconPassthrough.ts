import type { Plugin } from 'vite';

// In `npm run dev`, @crxjs/vite-plugin injects a client into the service worker that answers every
// request to the extension's own origin by forwarding it to the Vite dev server. That includes
// Chrome's built-in chrome-extension://<id>/_favicon/ endpoint, which only Chrome can serve: Vite
// answers 404, and every tab row shows the grey placeholder. Production builds have no such
// handler, so favicons only broke in dev.
//
// This plugin rewrites crxjs's worker client so `_favicon/` requests fall through to Chrome.

export const CRX_WORKER_CLIENT_ID = '/@crx/client-worker';

const ANCHOR = 'if (url.origin === ownOrigin) {';
const PATCHED = "if (url.origin === ownOrigin && !url.pathname.startsWith('/_favicon/')) {";

export function letFaviconsBypassDevProxy(code: string): string {
  const count = code.split(ANCHOR).length - 1;
  if (count !== 1) {
    // Fail the dev server loudly rather than silently regress favicons after a crxjs upgrade.
    throw new Error(
      `tab-hammer:favicon-passthrough expected one "${ANCHOR}" in ${CRX_WORKER_CLIENT_ID}, found ${count}. ` +
        'Has @crxjs/vite-plugin changed its worker client?',
    );
  }
  return code.replace(ANCHOR, PATCHED);
}

export function faviconPassthrough(): Plugin {
  return {
    name: 'tab-hammer:favicon-passthrough',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      if (id !== CRX_WORKER_CLIENT_ID) return null;
      return { code: letFaviconsBypassDevProxy(code), map: null };
    },
  };
}

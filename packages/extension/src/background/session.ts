// The one BrowserSession instance. A second instance would each renew the session ID on launch.
import { createBrowserSession } from './browserSession';

export const browserSession = createBrowserSession({
  local: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  },
  session: {
    get: (key) => chrome.storage.session.get(key),
    set: (items) => chrome.storage.session.set(items),
  },
  newId: () => crypto.randomUUID(),
});

// Other devices' open tabs through chrome.sessions (Chrome Sync, iOS included; no Drive, no
// sign-in), and "Open here" for them: chrome.sessions.restore where Chrome can, else the URLs.
import { sessionIdOfRow, type SessionDeviceLike } from '../../model/sync/devices';
import type { SyncWindow } from '../../model/sync/export';

export interface DeviceChrome {
  sessions: Pick<typeof chrome.sessions, 'getDevices' | 'restore'>;
  windows: Pick<typeof chrome.windows, 'create'>;
  tabs: Pick<typeof chrome.tabs, 'create'>;
}

/** Runs a create that opens a Chrome window, recording the window as Tab Hammer's own. */
export type OpenWindow = (
  create: () => Promise<chrome.windows.Window | undefined>,
) => Promise<chrome.windows.Window | undefined>;

export function createDeviceSource(c: DeviceChrome, openWindow: OpenWindow) {
  return {
    /** Every Chrome Sync device but this one. Empty when Chrome Sync or its tabs are off. */
    async read(): Promise<SessionDeviceLike[]> {
      return c.sessions.getDevices({ maxResults: 25 });
    },

    /** Opens a device's window or tab (`rowId` is one of `window`'s rows) on this computer. */
    async openHere(window: SyncWindow, rowId: string): Promise<void> {
      const isWindow = rowId === window.id;
      const sessionId = sessionIdOfRow(rowId);
      const urls = isWindow
        ? window.tabs.map((t) => t.url)
        : window.tabs.filter((t) => t.id === rowId).map((t) => t.url);
      if (urls.length === 0) throw new Error('Nothing to open');
      if (sessionId !== undefined) {
        try {
          if (isWindow) {
            const w = await openWindow(async () => (await c.sessions.restore(sessionId)).window);
            if (w) return;
          } else {
            await c.sessions.restore(sessionId);
            return;
          }
        } catch {
          // Chrome can't restore it (the device synced it away): open the addresses instead.
        }
      }
      if (isWindow) await openWindow(() => c.windows.create({ url: urls }));
      else await c.tabs.create({ url: urls[0] });
    },
  };
}

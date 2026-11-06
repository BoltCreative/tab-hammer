// Where each Chromium-family browser looks for a user-level native messaging host.
// macOS and Linux: a <host name>.json manifest in the browser's NativeMessagingHosts folder.
// Windows: an HKCU registry key whose default value is the manifest's path.
// Sources (checked November 2026): developer.chrome.com/docs/extensions/develop/concepts/native-messaging;
// Chromium's chrome/browser/extensions/api/messaging/launch_context_{win,posix}.cc, chrome_paths*.cc,
// and install_static (every Google Chrome channel on Windows reads Software\Google\Chrome; Chromium
// builds read Software\Chromium first); brave-core's brave_main_delegate.cc (Brave on macOS reads
// Chrome's folder, not its own); learn.microsoft.com native messaging for Edge. Arc publishes no
// docs: its paths come from other native hosts' installers (1Password, Strongbox, TabFS).
import fs from 'node:fs';
import { NATIVE_HOST_NAME } from '@tab-hammer/protocol';
import type { InstallEnv } from './env.ts';

export interface BrowserDef {
  id: string;
  name: string;
  /** Under ~/Library/Application Support: the user data folder. */
  mac?: string;
  /** Where its NativeMessagingHosts folder lives on macOS, when not inside `mac`. */
  macHosts?: string;
  /** Under ~/.config. */
  linux?: string;
  /** Windows: the user data folder under %LOCALAPPDATA% (for detection) and the HKCU key root. */
  win?: { dataDir: string; regRoot: string };
}

export const BROWSERS: readonly BrowserDef[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    mac: 'Google/Chrome',
    linux: 'google-chrome',
    win: { dataDir: 'Google/Chrome/User Data', regRoot: 'Software\\Google\\Chrome' },
  },
  {
    id: 'chrome-beta',
    name: 'Google Chrome Beta',
    mac: 'Google/Chrome Beta',
    linux: 'google-chrome-beta',
    win: { dataDir: 'Google/Chrome Beta/User Data', regRoot: 'Software\\Google\\Chrome' },
  },
  {
    id: 'chrome-dev',
    name: 'Google Chrome Dev',
    mac: 'Google/Chrome Dev',
    linux: 'google-chrome-unstable',
    win: { dataDir: 'Google/Chrome Dev/User Data', regRoot: 'Software\\Google\\Chrome' },
  },
  {
    id: 'chrome-canary',
    name: 'Google Chrome Canary',
    mac: 'Google/Chrome Canary',
    linux: 'google-chrome-canary',
    win: { dataDir: 'Google/Chrome SxS/User Data', regRoot: 'Software\\Google\\Chrome' },
  },
  {
    id: 'chromium',
    name: 'Chromium',
    mac: 'Chromium',
    linux: 'chromium',
    win: { dataDir: 'Chromium/User Data', regRoot: 'Software\\Chromium' },
  },
  {
    id: 'brave',
    name: 'Brave',
    mac: 'BraveSoftware/Brave-Browser',
    macHosts: 'Google/Chrome',
    linux: 'BraveSoftware/Brave-Browser',
    win: { dataDir: 'BraveSoftware/Brave-Browser/User Data', regRoot: 'Software\\Chromium' },
  },
  {
    id: 'brave-beta',
    name: 'Brave Beta',
    mac: 'BraveSoftware/Brave-Browser-Beta',
    macHosts: 'Google/Chrome',
    linux: 'BraveSoftware/Brave-Browser-Beta',
    win: { dataDir: 'BraveSoftware/Brave-Browser-Beta/User Data', regRoot: 'Software\\Chromium' },
  },
  {
    id: 'brave-nightly',
    name: 'Brave Nightly',
    mac: 'BraveSoftware/Brave-Browser-Nightly',
    macHosts: 'Google/Chrome',
    linux: 'BraveSoftware/Brave-Browser-Nightly',
    win: {
      dataDir: 'BraveSoftware/Brave-Browser-Nightly/User Data',
      regRoot: 'Software\\Chromium',
    },
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    mac: 'Microsoft Edge',
    linux: 'microsoft-edge',
    win: { dataDir: 'Microsoft/Edge/User Data', regRoot: 'Software\\Microsoft\\Edge' },
  },
  {
    id: 'edge-beta',
    name: 'Microsoft Edge Beta',
    mac: 'Microsoft Edge Beta',
    linux: 'microsoft-edge-beta',
    win: { dataDir: 'Microsoft/Edge Beta/User Data', regRoot: 'Software\\Microsoft\\Edge' },
  },
  {
    id: 'edge-dev',
    name: 'Microsoft Edge Dev',
    mac: 'Microsoft Edge Dev',
    linux: 'microsoft-edge-dev',
    win: { dataDir: 'Microsoft/Edge Dev/User Data', regRoot: 'Software\\Microsoft\\Edge' },
  },
  {
    id: 'edge-canary',
    name: 'Microsoft Edge Canary',
    mac: 'Microsoft Edge Canary',
    win: { dataDir: 'Microsoft/Edge SxS/User Data', regRoot: 'Software\\Microsoft\\Edge' },
  },
  {
    id: 'arc',
    name: 'Arc',
    mac: 'Arc/User Data',
    // Arc for Windows is an MSIX app: Packages\\TheBrowserCompany.Arc_<publisher id>\\...
    win: { dataDir: 'Packages/TheBrowserCompany.Arc', regRoot: 'Software\\Google\\Chrome' },
  },
];

/** One place a host gets registered on this machine. */
export type BrowserTarget =
  | {
      browser: BrowserDef;
      kind: 'file';
      dataDir: string;
      manifestDir: string;
      manifestPath: string;
    }
  | { browser: BrowserDef; kind: 'registry'; dataDir: string; key: string };

export function resolveBrowser(env: InstallEnv, b: BrowserDef): BrowserTarget | undefined {
  const p = env.path;
  const file = (dataDir: string, hostsDir = dataDir): BrowserTarget => {
    const manifestDir = p.join(hostsDir, 'NativeMessagingHosts');
    return {
      browser: b,
      kind: 'file',
      dataDir,
      manifestDir,
      manifestPath: p.join(manifestDir, `${NATIVE_HOST_NAME}.json`),
    };
  };
  if (env.os === 'darwin' && b.mac) {
    const support = p.join(env.home, 'Library', 'Application Support');
    return file(
      p.join(support, ...b.mac.split('/')),
      p.join(support, ...(b.macHosts ?? b.mac).split('/')),
    );
  }
  if (env.os === 'linux' && b.linux) return file(p.join(env.xdgConfig, ...b.linux.split('/')));
  if (env.os === 'win32' && b.win) {
    return {
      browser: b,
      kind: 'registry',
      dataDir: p.join(env.localAppData, ...b.win.dataDir.split('/')),
      key: `${b.win.regRoot}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    };
  }
  return undefined;
}

/**
 * Whether a browser has been run here: its user data folder holds the `Local State` file every
 * Chromium browser writes on first launch. (A bare folder isn't enough: registering Brave on macOS
 * creates Chrome's folder.) Arc's Windows package folder has a publisher suffix.
 */
export function detectBrowser(env: InstallEnv, t: BrowserTarget): boolean {
  if (env.os === 'win32' && t.browser.id === 'arc') {
    const parent = env.path.dirname(t.dataDir);
    const prefix = env.path.basename(t.dataDir) + '_';
    try {
      return fs.readdirSync(parent).some((n) => n.startsWith(prefix));
    } catch {
      return false;
    }
  }
  return fs.existsSync(env.path.join(t.dataDir, 'Local State'));
}

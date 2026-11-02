// `npm run install-mcp` (repo root): sets up the Claude ↔ Tab Hammer bridge on this machine.
//  1. Deploys the native host to ~/.tab-hammer/native-host (see deploy.ts for why it's a copy).
//  2. Registers it with each installed Chrome-family browser (a host manifest file per browser).
//  3. Registers the MCP server with Claude Code, user scope, as `tab-hammer`.
// `npm run uninstall-mcp` undoes all three. Re-running install is safe; it replaces everything.
//
// The MCP server runs from this checkout (it needs its npm dependencies), so run this from the
// checkout you'll keep, not a throwaway worktree.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_HOST_NAME } from '@tab-hammer/protocol';
import { deployHost, hostManifest } from './deploy.ts';

const HOME = os.homedir();
const HOST_DIR = path.join(HOME, '.tab-hammer', 'native-host');
const MCP_MAIN = path.join(import.meta.dirname, 'main.ts');
const MCP_NAME = 'tab-hammer';

// Each browser's user data folder; its NativeMessagingHosts subfolder is where Chrome looks.
const BROWSER_DIRS =
  process.platform === 'darwin'
    ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium'].map((d) =>
        path.join(HOME, 'Library', 'Application Support', d),
      )
    : ['google-chrome', 'google-chrome-beta', 'chromium'].map((d) => path.join(HOME, '.config', d));

function claude(args: string[]): boolean {
  const r = spawnSync('claude', args, { stdio: 'inherit' });
  return r.status === 0;
}

function install(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error(
      `Node 22.18+ is required (it runs TypeScript directly); this is ${process.version}.`,
    );
  }

  const launcher = deployHost(HOST_DIR);
  console.log(`Native host deployed to ${HOST_DIR}`);

  const browsers = BROWSER_DIRS.filter((d) => fs.existsSync(d));
  if (browsers.length === 0) console.warn('No Chrome or Chromium profile folder found.');
  for (const dir of browsers) {
    const hosts = path.join(dir, 'NativeMessagingHosts');
    fs.mkdirSync(hosts, { recursive: true });
    fs.writeFileSync(
      path.join(hosts, `${NATIVE_HOST_NAME}.json`),
      JSON.stringify(hostManifest(launcher), null, 2) + '\n',
    );
    console.log(`Registered with ${path.basename(dir)}`);
  }

  // `add` refuses to overwrite, so drop any earlier registration first (fine if there was none).
  spawnSync('claude', ['mcp', 'remove', '-s', 'user', MCP_NAME], { stdio: 'ignore' });
  const added = claude(['mcp', 'add', '-s', 'user', MCP_NAME, '--', process.execPath, MCP_MAIN]);
  if (!added) {
    console.warn(
      `\nCouldn't register with Claude Code. Run this yourself:\n` +
        `  claude mcp add -s user ${MCP_NAME} -- "${process.execPath}" "${MCP_MAIN}"`,
    );
  }

  console.log(
    '\nDone. Reload Tab Hammer in chrome://extensions (or click its toolbar icon) so it connects,\n' +
      'then start a new Claude Code session.',
  );
}

function uninstall(): void {
  fs.rmSync(HOST_DIR, { recursive: true, force: true });
  for (const dir of BROWSER_DIRS) {
    fs.rmSync(path.join(dir, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`), { force: true });
  }
  claude(['mcp', 'remove', '-s', 'user', MCP_NAME]);
  console.log('Removed the Tab Hammer native host and MCP server registration.');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();

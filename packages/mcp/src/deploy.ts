// Copies the native host and the MCP server out of the package into a per-user folder, and makes
// the launcher Chrome runs.
//
// Why a copy: macOS blocks apps from reading ~/Documents, ~/Desktop, and similar folders until the
// user approves a prompt, and a host Chrome starts from a repo there hangs on its first file read.
// A copy also keeps working after `npx` clears its cache, or the checkout it came from is gone.
//
// What gets copied is the built package (`npm run build` in packages/mcp): host.js is the host
// bundled into one file with no npm packages, and server.js the MCP server with its dependencies
// bundled in, so the folder needs no node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME, EXTENSION_ID, STORE_EXTENSION_ID } from '@tab-hammer/protocol';

/** The folder holding the built host.js and server.js: this module's own, once bundled. */
export const BUILT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const HOST_FILE = 'host.js';
export const SERVER_FILE = 'server.js';

export interface DeployOptions {
  /** Node binary the launcher pins (Chrome runs the host with no PATH lookup we control). */
  nodePath?: string;
  /** 'win32' writes a .bat launcher; anything else a shell script. */
  os?: string;
  /** Where the built host.js / server.js are (defaults to BUILT_DIR). */
  builtDir?: string;
  /** Path functions matching `os` (tests simulate Windows with posix paths). */
  path?: typeof path.posix;
}

export function launcherName(os: string = process.platform): string {
  return os === 'win32' ? 'tab-hammer-host.bat' : 'tab-hammer-host';
}

/** Writes the host into `dir` and returns the launcher Chrome should run. */
export function deployHost(dir: string, opts: DeployOptions = {}): string {
  const { nodePath = process.execPath, os = process.platform, builtDir = BUILT_DIR } = opts;
  const p = opts.path ?? path;
  const built = path.join(builtDir, HOST_FILE);
  if (!fs.existsSync(built)) {
    throw new Error(
      `${built} is missing. Build the package first (npm run build -w tab-hammer-mcp).`,
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(built, p.join(dir, HOST_FILE));
  fs.writeFileSync(p.join(dir, 'package.json'), '{ "type": "module" }\n');
  const launcher = p.join(dir, launcherName(os));
  if (os === 'win32') {
    // %~dp0 is the .bat's own folder. Chrome passes the caller origin (and a window handle) as args.
    fs.writeFileSync(launcher, `@echo off\r\n"${nodePath}" "%~dp0${HOST_FILE}" %*\r\n`);
  } else {
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${nodePath}" "${p.join(dir, HOST_FILE)}" "$@"\n`, {
      mode: 0o755,
    });
  }
  return launcher;
}

/** Copies the MCP server next to the host and returns the script harnesses should run. */
export function deployServer(dir: string, opts: DeployOptions = {}): string {
  const { builtDir = BUILT_DIR } = opts;
  const p = opts.path ?? path;
  fs.mkdirSync(dir, { recursive: true });
  const target = p.join(dir, SERVER_FILE);
  fs.copyFileSync(path.join(builtDir, SERVER_FILE), target);
  return target;
}

/** Every extension ID allowed to talk to the host: the dev build's, the store's, and any extras. */
export function extensionIds(extra: readonly string[] = []): string[] {
  return [
    ...new Set([EXTENSION_ID, ...(STORE_EXTENSION_ID ? [STORE_EXTENSION_ID] : []), ...extra]),
  ];
}

/** The native messaging host manifest Chrome looks up by NATIVE_HOST_NAME. */
export function hostManifest(launcher: string, extraIds: readonly string[] = []) {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Tab Hammer bridge for AI agents (MCP)',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds(extraIds).map((id) => `chrome-extension://${id}/`),
  };
}

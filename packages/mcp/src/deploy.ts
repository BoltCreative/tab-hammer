// Copies the native host out of the repo into a folder Chrome can run it from.
//
// Why a copy: macOS blocks apps from reading ~/Documents, ~/Desktop, and similar folders until the
// user approves a prompt, and a host Chrome starts from a repo there hangs on its first file read.
// A copy under ~/.tab-hammer also keeps working after the checkout or worktree it came from is gone.
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_HOST_NAME, EXTENSION_ID } from '@tab-hammer/protocol';

const SRC = import.meta.dirname;

// host.ts and everything it imports. Checked by the bridge tests, which run the deployed copy.
const HOST_FILES = ['host.ts', 'nativeHost.ts', 'framing.ts', 'lines.ts', 'paths.ts'];

/** Writes the host into `dir` and returns the executable Chrome should launch. */
export function deployHost(dir: string, nodePath = process.execPath): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of HOST_FILES) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  // Chrome runs `path` directly with no PATH lookup we control, so pin the absolute node binary.
  const launcher = path.join(dir, 'tab-hammer-host');
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${nodePath}" "${path.join(dir, 'host.ts')}" "$@"\n`,
    {
      mode: 0o755,
    },
  );
  return launcher;
}

/** The native messaging host manifest Chrome looks up by NATIVE_HOST_NAME. */
export function hostManifest(launcher: string) {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Tab Hammer bridge for Claude (MCP)',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

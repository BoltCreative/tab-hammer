// Entry point Chrome starts as the native messaging host (see nativeHost.ts). The installer copies
// this folder out of the repo first (deploy.ts), so keep this entry's imports free of npm packages.
// stdout is the channel to Chrome: diagnostics go to stderr only.
import { runNativeHost } from './nativeHost.ts';
import { socketPath } from './paths.ts';

const host = runNativeHost({
  fromChrome: process.stdin,
  toChrome: process.stdout,
  socketPath: socketPath(),
});
host.ready.catch((err: unknown) => {
  console.error('tab-hammer native host: could not listen', err);
  process.exit(1);
});
void host.closed.then(() => process.exit(0));

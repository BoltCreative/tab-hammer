// The MCP server's side of the bridge: one short-lived socket (or Windows named pipe) connection per call to the native
// host, which relays it to Tab Hammer in Chrome.
import net from 'node:net';
import type { BridgeResponse, Method, Methods } from '@tab-hammer/protocol';
import { onLines } from './lines.ts';

const CALL_TIMEOUT_MS = 15_000;

export const NOT_CONNECTED =
  "Tab Hammer isn't reachable. Your browser must be running with the Tab Hammer extension loaded, " +
  'and the native host installed (`npx tab-hammer-mcp install`, then reload the extension). ' +
  '`npx tab-hammer-mcp doctor` says what is missing.';

export class BridgeError extends Error {}

export function callBridge<M extends Method>(
  socketPath: string,
  method: M,
  params: Methods[M]['params'],
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Methods[M]['result']> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BridgeError(`Tab Hammer didn't answer ${method} within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      socket.end();
    };
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new BridgeError(
          err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NOT_CONNECTED : err.message,
        ),
      );
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new BridgeError('Tab Hammer closed the connection before answering.'));
    });
    onLines(socket, (line) => {
      const res = JSON.parse(line) as BridgeResponse;
      finish();
      if (res.ok) resolve(res.result as Methods[M]['result']);
      else reject(new BridgeError(res.error));
    });
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + '\n');
    });
  });
}

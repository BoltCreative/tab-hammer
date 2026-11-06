// The native messaging host: Chrome starts it when Tab Hammer's service worker calls
// chrome.runtime.connectNative, and it lives as long as that connection. It listens on a Unix
// socket (a named pipe on Windows) for MCP servers (one per Claude session) and relays each request to the extension,
// routing responses back to whichever server asked. It never interprets a request itself.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { BridgeRequest, BridgeResponse } from '@tab-hammer/protocol';
import { encodeFrame, FrameDecoder } from './framing.ts';
import { onLines } from './lines.ts';
import { isPipePath } from './paths.ts';

interface Pending {
  socket: net.Socket;
  clientId: number;
}

export interface NativeHost {
  /** Resolves once the socket is listening. */
  ready: Promise<void>;
  /** Resolves after Chrome's side closes and the socket is cleaned up. */
  closed: Promise<void>;
}

export function runNativeHost(opts: {
  fromChrome: Readable;
  toChrome: Writable;
  socketPath: string;
}): NativeHost {
  const { fromChrome, toChrome, socketPath } = opts;
  const pending = new Map<number, Pending>(); // keyed by the id sent to Chrome
  const sockets = new Set<net.Socket>();
  let nextId = 1;
  let listeningInode = -1;

  const reply = (p: Pending, response: BridgeResponse) => {
    if (!p.socket.destroyed) p.socket.write(JSON.stringify({ ...response, id: p.clientId }) + '\n');
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      for (const [id, p] of pending) if (p.socket === socket) pending.delete(id);
    });
    onLines(socket, (line) => {
      let req: BridgeRequest;
      try {
        req = JSON.parse(line) as BridgeRequest;
      } catch {
        socket.write(JSON.stringify({ id: -1, ok: false, error: 'malformed request' }) + '\n');
        return;
      }
      const id = nextId++;
      pending.set(id, { socket, clientId: req.id });
      toChrome.write(encodeFrame({ ...req, id }));
    });
  });

  const decoder = new FrameDecoder();
  fromChrome.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const response = msg as BridgeResponse;
      const p = pending.get(response.id);
      if (!p) continue;
      pending.delete(response.id);
      reply(p, response);
    }
  });

  // A Windows named pipe has no file: Windows removes it when the last handle closes, and a second
  // host can't take it over while the first runs, so that one fails to listen and exits.
  const pipe = isPipePath(socketPath);
  if (!pipe) {
    // A stale socket file (from a host that crashed) would make listen() fail; the newest host wins.
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.rmSync(socketPath, { force: true });
  }
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (!pipe) {
        fs.chmodSync(socketPath, 0o600);
        listeningInode = fs.statSync(socketPath).ino;
      }
      resolve();
    });
  });

  const closed = new Promise<void>((resolve) => {
    fromChrome.once('end', () => {
      for (const p of pending.values()) {
        reply(p, { id: p.clientId, ok: false, error: 'Tab Hammer disconnected' });
      }
      pending.clear();
      server.close(() => resolve());
      for (const s of sockets) s.end();
      // Only remove the socket file if it is still ours (a newer host may have replaced it).
      if (pipe) return;
      try {
        if (fs.statSync(socketPath).ino === listeningInode) fs.rmSync(socketPath);
      } catch {
        /* already gone */
      }
    });
  });

  return { ready, closed };
}

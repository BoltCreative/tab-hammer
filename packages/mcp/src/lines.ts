import type { Socket } from 'node:net';

/** Calls `onLine` with each newline-terminated line the socket receives. */
export function onLines(socket: Socket, onLine: (line: string) => void): void {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

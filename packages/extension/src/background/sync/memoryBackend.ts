// An in-memory SyncBackend for unit tests: shared by several simulated installs, with a switch to
// take it offline and a log of which files were downloaded.
import { NotFoundError, type RemoteFile, type SyncBackend } from './backend';

export interface MemoryBackend extends SyncBackend {
  files: Map<string, { content: string; modifiedTime: number }>;
  offline: boolean;
  reads: string[]; // names read, in order
}

export function createMemoryBackend(now: () => number = Date.now): MemoryBackend {
  const files = new Map<string, { content: string; modifiedTime: number }>();
  let last = 0;
  const b: MemoryBackend = {
    files,
    offline: false,
    reads: [],
    async list() {
      check();
      return [...files].map(([name, f]): RemoteFile => ({ name, modifiedTime: f.modifiedTime }));
    },
    async read(name) {
      check();
      b.reads.push(name);
      const f = files.get(name);
      if (!f) throw new NotFoundError(name);
      return f.content;
    },
    async write(name, content) {
      check();
      // Strictly increasing, as Drive's modifiedTime is per write.
      const modifiedTime = Math.max(now(), last + 1);
      last = modifiedTime;
      files.set(name, { content, modifiedTime });
      return { name, modifiedTime };
    },
    async remove(name) {
      check();
      files.delete(name);
    },
  };
  function check() {
    if (b.offline) throw new TypeError('Failed to fetch');
  }
  return b;
}

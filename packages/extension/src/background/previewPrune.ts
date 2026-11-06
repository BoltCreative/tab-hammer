// Deletes previews the outline no longer uses: run on startup and after outline changes, with
// bursts of changes coalesced into one run at a time (plus at most one queued behind it).
import { referencedKeys } from '../shared/previewPolicy';

export interface PreviewPrunerDeps {
  /** Every window record's tabs (live, hibernated, trashed), after the outline's queued work; null
   *  while the outline isn't loaded, when nothing may be deleted. */
  outlineWindows: () => Promise<readonly { tabs: readonly { url: string }[] }[] | null>;
  openUrls: () => Promise<string[]>; // the pages Chrome has open now
  prune: (referenced: ReadonlySet<string>, since: number) => Promise<void>;
  now: () => number;
  onError?: (err: unknown) => void;
}

export interface PreviewPruner {
  schedule(): void;
  /** Runs a prune now (after any in progress) and resolves once it's done. */
  run(): Promise<void>;
}

export function createPreviewPruner(deps: PreviewPrunerDeps): PreviewPruner {
  let running: Promise<void> | null = null;
  let again = false;

  async function once(): Promise<void> {
    // Stamped before reading: a preview saved from here on is kept this round (see pickEvictions).
    const since = deps.now();
    const windows = await deps.outlineWindows();
    if (windows === null) return;
    const referenced = referencedKeys(windows, await deps.openUrls());
    await deps.prune(referenced, since);
  }

  function start(): Promise<void> {
    running = (async () => {
      do {
        again = false;
        try {
          await once();
        } catch (err) {
          (deps.onError ?? console.error)(err);
        }
      } while (again);
      running = null;
    })();
    return running;
  }

  return {
    schedule() {
      if (running) again = true;
      else void start();
    },
    async run() {
      if (running) {
        again = true;
        await running;
        return;
      }
      await start();
    },
  };
}

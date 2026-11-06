import { describe, expect, it } from 'vitest';
import { createPreviewPruner } from '../previewPrune';

function setup(windows: { tabs: { url: string }[] }[] | null, openUrls: string[] = []) {
  const runs: { referenced: string[]; since: number }[] = [];
  let clock = 100;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const pruner = createPreviewPruner({
    outlineWindows: async () => windows,
    openUrls: async () => openUrls,
    prune: async (referenced, since) => {
      runs.push({ referenced: [...referenced].sort(), since });
      if (gate) await gate;
    },
    now: () => clock++,
  });
  return {
    pruner,
    runs,
    hold() {
      gate = new Promise((r) => (release = r));
    },
    release: () => {
      gate = undefined;
      release?.();
    },
  };
}

describe('preview pruner', () => {
  it("prunes against the outline's tabs and Chrome's open pages, stamped before reading", async () => {
    const t = setup([{ tabs: [{ url: 'https://a.test/#x' }] }], ['https://b.test/']);
    await t.pruner.run();
    expect(t.runs).toEqual([{ referenced: ['https://a.test/', 'https://b.test/'], since: 100 }]);
  });

  it('deletes nothing while the outline is not loaded', async () => {
    const t = setup(null, ['https://b.test/']);
    await t.pruner.run();
    expect(t.runs).toEqual([]);
  });

  it('coalesces a burst of changes into one more run after the one in progress', async () => {
    const t = setup([{ tabs: [] }]);
    t.hold();
    t.pruner.schedule();
    await Promise.resolve();
    for (let i = 0; i < 5; i++) t.pruner.schedule();
    const done = t.pruner.run();
    t.release();
    await done;
    expect(t.runs).toHaveLength(2);
  });
});

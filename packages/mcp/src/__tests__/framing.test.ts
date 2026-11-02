import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder } from '../framing.ts';

describe('FrameDecoder', () => {
  it('reassembles a frame split at every possible byte, including inside a multi-byte character', () => {
    const msg = { id: 7, title: 'café — 日本' };
    const frame = encodeFrame(msg);
    for (let cut = 1; cut < frame.length; cut++) {
      const d = new FrameDecoder();
      expect(d.push(frame.subarray(0, cut))).toEqual([]);
      expect(d.push(frame.subarray(cut))).toEqual([msg]);
    }
  });

  it('yields several frames from one chunk, in order, and keeps a trailing partial', () => {
    const d = new FrameDecoder();
    const third = encodeFrame({ n: 3 });
    const chunk = Buffer.concat([
      encodeFrame({ n: 1 }),
      encodeFrame({ n: 2 }),
      third.subarray(0, 5),
    ]);
    expect(d.push(chunk)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(d.push(third.subarray(5))).toEqual([{ n: 3 }]);
  });
});

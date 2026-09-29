import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearPreviews, getPreview, putPreview } from '../previewStore';

const shot = (capturedAt: number) => ({
  capturedAt,
  image: new Blob(['x'], { type: 'image/jpeg' }),
  width: 640,
  height: 360,
});

describe('clearPreviews', () => {
  it('deletes every preview and leaves the store usable', async () => {
    await putPreview('https://example.com/a', shot(1));
    await putPreview('https://example.com/b#x', shot(2));
    await clearPreviews();
    expect(await getPreview('https://example.com/a')).toBeUndefined();
    expect(await getPreview('https://example.com/b')).toBeUndefined();
    // No reopen or reload needed: the next write lands and counts from zero.
    await expect(putPreview('https://example.com/c', shot(3))).resolves.toBe(1);
    expect((await getPreview('https://example.com/c'))?.capturedAt).toBe(3);
  });
});

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearPreviews, deletePreviews, getPreview, putPreview } from '../previewStore';

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

describe('deletePreviews', () => {
  it('deletes the named pages (fragments ignored) and keeps the rest', async () => {
    await clearPreviews();
    await putPreview('https://example.com/a', shot(1));
    await putPreview('https://example.com/b', shot(2));
    await putPreview('https://example.com/c', shot(3));
    await deletePreviews(['https://example.com/a#intro', 'https://example.com/b', 'https://nope/']);
    expect(await getPreview('https://example.com/a')).toBeUndefined();
    expect(await getPreview('https://example.com/b')).toBeUndefined();
    expect((await getPreview('https://example.com/c'))?.capturedAt).toBe(3);
  });
});

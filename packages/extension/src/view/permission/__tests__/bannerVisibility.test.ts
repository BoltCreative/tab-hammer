import { describe, expect, it } from 'vitest';
import { shouldShowBanner } from '../bannerVisibility';

describe('shouldShowBanner', () => {
  it('hides while the permission check is still pending', () => {
    expect(shouldShowBanner(null)).toBe(false);
  });

  it('hides once the permission is granted', () => {
    expect(shouldShowBanner(true)).toBe(false);
  });

  it('shows once the permission is confirmed missing', () => {
    expect(shouldShowBanner(false)).toBe(true);
  });
});

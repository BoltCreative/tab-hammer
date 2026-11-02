import { useEffect, useState } from 'react';
import {
  hasPreviewPermission,
  requestPreviewPermission,
  subscribePreviewPermission,
} from '../chrome/permissions';
import { shouldShowBanner } from './bannerVisibility';

/**
 * Slim banner shown when hover previews can't capture screenshots because the <all_urls> host
 * permission isn't granted (Chrome may not re-grant it after an unpacked reload, and the user can
 * withhold or revoke site access at any time). Disappears as soon as the permission is granted,
 * from this banner's own button or from chrome://extensions.
 */
export function PreviewPermissionBanner() {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      hasPreviewPermission()
        .then((g) => {
          if (!cancelled) setGranted(g);
        })
        .catch((err: unknown) =>
          console.error('Tab Hammer: checking preview permission failed', err),
        );
    };
    check();
    const unsubscribe = subscribePreviewPermission(check);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!shouldShowBanner(granted)) return null;

  const onAllow = () => {
    // Called directly here, with nothing awaited first, so Chrome still sees the click as the
    // user gesture chrome.permissions.request requires.
    requestPreviewPermission()
      .then(setGranted)
      .catch((err: unknown) =>
        console.error('Tab Hammer: requesting preview permission failed', err),
      );
  };

  return (
    <div className="permission-banner" role="status" data-testid="permission-banner">
      <span>Hover previews need access to all sites.</span>
      <button type="button" onClick={onAllow}>
        Allow previews
      </button>
    </div>
  );
}

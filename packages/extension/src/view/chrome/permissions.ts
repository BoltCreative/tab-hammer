// The view's permission checks and requests. The only view module that touches chrome.permissions.
//
// Hover previews need host access to every site to screenshot a window's visible tab (see
// ../../background/captureWindow.ts). Chrome may leave that permission ungranted after an
// unpacked reload, and the user can withhold or revoke site access at any time, so the view
// checks it on load and offers to request it.
//
// Chrome Sync devices need the optional `sessions` permission, which the devices panel asks for.
const PREVIEW_ORIGINS = ['<all_urls>'];
const DEVICES_PERMISSIONS: chrome.runtime.ManifestPermission[] = ['sessions'];

export function hasPreviewPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: PREVIEW_ORIGINS });
}

// Must be called directly from a click handler: chrome.permissions.request only works inside a
// user gesture, so nothing here may await anything before making the call.
export function requestPreviewPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: PREVIEW_ORIGINS });
}

export function hasDevicesPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: DEVICES_PERMISSIONS });
}

// Must be called directly from a click handler, like requestPreviewPermission.
export function requestDevicesPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: DEVICES_PERMISSIONS });
}

/** Fires onChange whenever any permission is granted or withdrawn; callers re-check what they need. */
export function subscribePermissions(onChange: () => void): () => void {
  chrome.permissions.onAdded.addListener(onChange);
  chrome.permissions.onRemoved.addListener(onChange);
  return () => {
    chrome.permissions.onAdded.removeListener(onChange);
    chrome.permissions.onRemoved.removeListener(onChange);
  };
}

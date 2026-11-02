// Hover previews need host access to every site to screenshot a window's visible tab (see
// ../../background/captureWindow.ts). Chrome may leave that permission ungranted after an
// unpacked reload, and the user can withhold or revoke site access at any time, so the view
// checks it on load and offers to request it. The only view module that touches chrome.*.
const PREVIEW_ORIGINS = ['<all_urls>'];

export function hasPreviewPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: PREVIEW_ORIGINS });
}

// Must be called directly from a click handler: chrome.permissions.request only works inside a
// user gesture, so nothing here may await anything before making the call.
export function requestPreviewPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: PREVIEW_ORIGINS });
}

/** Fires onChange whenever any permission is granted or withdrawn; callers re-check what they need. */
export function subscribePreviewPermission(onChange: () => void): () => void {
  chrome.permissions.onAdded.addListener(onChange);
  chrome.permissions.onRemoved.addListener(onChange);
  return () => {
    chrome.permissions.onAdded.removeListener(onChange);
    chrome.permissions.onRemoved.removeListener(onChange);
  };
}

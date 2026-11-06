// Drive sync's Google sign-in. Fill in GOOGLE_OAUTH_CLIENT_ID to turn Drive sync on: an OAuth
// client of type "Chrome extension" for extension ID lpnkidobhhpmokecbinbliomjehmndia (pinned by
// the manifest key), in a Google Cloud project with the Drive API enabled. The ID isn't secret.
// While it's empty, the manifest has no oauth2 block and Drive sync is off: the device picker still
// shows Chrome Sync devices and this computer's local checkpoints.
export const GOOGLE_OAUTH_CLIENT_ID: string =
  '652721949721-idna0tvksq0l7dvka1qd0cjcc7dlsj4c.apps.googleusercontent.com';

// The same for the Chrome Web Store build (`npm run build:store`), which has no manifest key and
// so runs under the ID the store assigns: an OAuth client is bound to one extension ID, so the
// store needs its own ("Chrome extension" type, for store item ID dcgapifimbojbcgenneeiaoobaabgnib,
// in the same project). While it's empty, the store build ships with Drive sync off.
export const STORE_GOOGLE_OAUTH_CLIENT_ID: string =
  '652721949721-gu9hjjbc7ovh0bdlg0kkirpfr9bu3gmb.apps.googleusercontent.com';

/** Drive's hidden per-app folder only: Tab Hammer can't see the user's other Drive files. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

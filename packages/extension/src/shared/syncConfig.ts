// Drive sync's Google sign-in. Fill in GOOGLE_OAUTH_CLIENT_ID to turn Drive sync on: an OAuth
// client of type "Chrome extension" for extension ID lpnkidobhhpmokecbinbliomjehmndia (pinned by
// the manifest key), in a Google Cloud project with the Drive API enabled. The ID isn't secret.
// While it's empty, the manifest has no oauth2 block and Drive sync is off: the device picker still
// shows Chrome Sync devices and this computer's local checkpoints.
export const GOOGLE_OAUTH_CLIENT_ID = '';

/** Drive's hidden per-app folder only: Tab Hammer can't see the user's other Drive files. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

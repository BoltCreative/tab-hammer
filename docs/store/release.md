# Releasing to the Chrome Web Store

Uploads and submissions run in GitHub Actions. Nobody uploads zips by hand after the first one.

- **Every merge to main uploads a draft.** Once CI passes on main, the **Store upload** workflow
  (`.github/workflows/store.yml`) builds the store package (`npm run build:store`) and uploads it
  to the store item as its draft. It submits nothing. A merge that changes only Markdown uploads
  nothing.
- **Release submits the draft for review.** Run **Actions → Release → Run workflow** on main
  (`.github/workflows/release.yml`). The store publishes the draft once it passes review.

## Versions

The store refuses an upload whose version isn't above the last one. So CI adds a fourth part to the
manifest's version: main's commit count. `0.1.0` in `packages/extension/src/manifest.ts` uploads
as `0.1.0.57`, the next merge as `0.1.0.58`, and so on. Nothing is committed to bump it, so
merges never conflict over the version. Each uploaded commit is tagged `store/<version>`
(`store/0.1.0.57`), so you can tell which commit a store version came from.

To change the version users see, bump the release version in a PR as usual:

```
npm run release -- minor      # or patch, major, or an exact version like 1.4.0
```

This sets the version in the manifest, every `package.json`, `package-lock.json`, and the MCP
registry listing (`packages/mcp/server.json`), and refuses one that isn't above the current
version. Once the PR merges, the draft becomes `0.2.0.<count>`,
above every `0.1.0.*`. Local `npm run build:store` builds have no fourth part.

## When a review is pending

While a submission waits on review, the store takes neither a new upload nor a new submission.

- **Store upload** leaves the draft alone and finishes with a warning. After the review ends, run
  **Actions → Store upload → Run workflow** on main to upload main's latest build, or let the next
  merge do it.
- **Release** fails with "A review is already pending, for version …" and submits nothing. Wait
  for the review, or cancel it in the developer dashboard and run Release again.

## One-time setup

Until these secrets are set, Store upload finishes with a notice that nothing was uploaded, and
Release fails saying which secret is missing. Secrets are only used by these two workflows, which
run on main only. Pull requests, forks included, never see them.

### 1. Create the item

The API only updates an item that already exists. Build the zip locally (`npm run build:store`),
upload it in the [developer dashboard](https://chrome.google.com/webstore/devconsole) to create the
item, and fill in the listing from `docs/store/listing.md`. CI's uploads (`0.1.0.<count>`) are
above that zip's `0.1.0`.

The store then shows the item's extension ID. Put it in `STORE_EXTENSION_ID`
(`packages/protocol/src/index.ts`) so the MCP installer allows the store build to reach the native
host, and publish the MCP package (below).

### 2. A service account for CI

1. In the [Google Cloud console](https://console.cloud.google.com/), pick a project (the one with
   the Drive OAuth client is fine), search for **Chrome Web Store API**, and enable it.
2. Go to **IAM & Admin → Service accounts**, create one (it needs no roles), then open it and
   choose **Keys → Add key → Create new key → JSON**. A key file downloads.
3. In the developer dashboard's **Account** page, add the service account's email
   (`…@….iam.gserviceaccount.com`). A publisher can have only one service account.

If the console says key creation is disabled (an organization policy), use a refresh token instead;
see below.

### 3. GitHub secrets

In the repository's **Settings → Secrets and variables → Actions**, add:

| Secret                    | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| `CWS_PUBLISHER_ID`        | Your publisher ID, from the developer dashboard's publisher settings.       |
| `CWS_ITEM_ID`             | The item's extension ID (32 letters), shown on the item in the dashboard.   |
| `CWS_SERVICE_ACCOUNT_KEY` | The whole JSON key file: `gh secret set CWS_SERVICE_ACCOUNT_KEY < key.json` |

Then delete the downloaded key file. To check the setup, run **Actions → Store upload → Run
workflow** on main.

### Instead of a service account: a refresh token

Use this only if you can't make a service account key. The Google account must own the item and
have 2-step verification on.

1. In the same Cloud project, set up the **OAuth consent screen** (External) and publish it to
   **In production**. While it's in Testing, refresh tokens expire after 7 days and uploads start
   failing a week later.
2. Create an **OAuth client ID** of type **Web application**, with
   `https://developers.google.com/oauthplayground` as an authorized redirect URI.
3. In the [OAuth Playground](https://developers.google.com/oauthplayground), open the settings
   (gear), choose **Use your own OAuth credentials**, and enter the client's ID and secret.
   Authorize the scope `https://www.googleapis.com/auth/chromewebstore`, then **Exchange
   authorization code for tokens**.
4. Add the secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN` in place of
   `CWS_SERVICE_ACCOUNT_KEY` (keep `CWS_PUBLISHER_ID` and `CWS_ITEM_ID`). If both are set, the
   service account wins.

## The store build

`npm run build:store` builds into `packages/extension/dist-store/` and writes
`packages/extension/release/tab-hammer-<version>.zip`. It differs from the dev build in two ways.
It has no manifest `key` (the store rejects one and assigns its own extension ID), and it signs in
to Drive with `STORE_GOOGLE_OAUTH_CLIENT_ID` from `packages/extension/src/shared/syncConfig.ts`,
not the dev client (an OAuth client only works for one extension ID). While that constant is
empty, the store build ships with Drive sync off. The script fails if the zip's manifest still has
a `key` or the dev client.

## First release only

- Create a Google Cloud OAuth client of type "Chrome extension" for the store item's ID (same
  project as the dev client, Drive API enabled), put its client ID in
  `STORE_GOOGLE_OAUTH_CLIENT_ID`, and merge it to turn on Drive sync in the store build.
- Publish `docs/store/privacy-policy.md` at `https://boltcreative.com/tab-hammer/privacy` (the
  boltcreative.com site's repo holds the published copy; keep the two in step) and paste that
  address into the dashboard's privacy tab, then fill in the rest from `docs/store/listing.md`.
- Check the listing still matches `docs/store/listing.md` before each Release, especially the
  permission justifications when the manifest's permissions changed.

## Publishing the MCP package

The `tab-hammer-mcp` npm package (`packages/mcp`) shares the release version. After the gate
passes on the release commit:

1. `cd packages/mcp && npm publish --access public`. `prepublishOnly` builds `dist/` and runs the
   package's tests first.
2. List it in the MCP registry, from `packages/mcp` (install the publisher once with
   `brew install mcp-publisher`):

   ```
   mcp-publisher login github
   mcp-publisher publish
   ```

   The registry checks that `server.json`'s `name` matches `mcpName` in `package.json` and that
   the npm version exists, so publish to npm first. Check the listing with
   `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.BoltCreative/tab-hammer"`.

# Releasing

Releases run in GitHub Actions, from one button. Nobody uploads zips or publishes packages by hand
after the first time.

Merging to main only runs CI. To release main, run **Actions → Release → Run workflow** with main
selected (`.github/workflows/release.yml`; it refuses any other branch). It has three parts, each
with its own job and a line in the run's summary:

- **Chrome Web Store** builds the store package (`npm run build:store`), uploads it to the store
  item as its draft, and submits the draft for review. The store publishes it once it passes.
- **npm** publishes the `tab-hammer-mcp` package (`packages/mcp`), unless npm already has its
  version.
- **MCP registry** lists `packages/mcp/server.json` in the MCP registry once npm has the version,
  unless the registry already has it.

The store and npm parts don't wait on each other: missing store secrets or a pending store review
never hold back the MCP package. Running Release again is safe, since each part skips what's
already out; rerun it after fixing whatever failed.

## Versions

The store refuses an upload whose version isn't above the last one. So Release adds a fourth part
to the manifest's version: main's commit count. `0.1.0` in `packages/extension/src/manifest.ts`
uploads as `0.1.0.57`, a release a few merges later as `0.1.0.61`, and so on. Nothing is
committed to bump it, so merges never conflict over the version. Each uploaded commit is tagged
`store/<version>` (`store/0.1.0.57`), so you can tell which commit a store version came from.

The MCP package has no fourth part: npm and the MCP registry take each version once, so they get
a new release only after the release version is bumped (below). Until then Release reports them
as already published.

To change the version users see, bump the release version in a PR as usual:

```
npm run release -- minor      # or patch, major, or an exact version like 1.4.0
```

This sets the version in the manifest, every `package.json`, `package-lock.json`, and the MCP
registry listing (`packages/mcp/server.json`), and refuses one that isn't above the current
version. Once it reaches main, the next Release uploads `0.2.0.<count>`, above every `0.1.0.*`,
and publishes `tab-hammer-mcp@0.2.0`. Local `npm run build:store` builds have no fourth part.

## When a review is pending

While a submission waits on review, the store takes neither a new upload nor a new submission.
Release's store part then uploads and submits nothing, and fails with the pending version in its
summary line. Wait for the review, or cancel it in the developer dashboard, and run Release again.
(If the pending review is for this very build, from an earlier Release, it says so and passes.)

## One-time setup

Until the store secrets are set, the store part finishes with a notice that nothing was uploaded,
and the rest of Release still runs. The secrets are only used by Release, which runs on main
only. Pull requests, forks included, never see them. npm and the MCP registry need no secrets: they
trust the Release workflow itself through GitHub's OIDC tokens.

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

Then delete the downloaded key file. To check the setup, run Release on main.

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

The `tab-hammer-mcp` npm package (`packages/mcp`) shares the release version, and Release
publishes it.

- **npm**: `npm publish --access public --provenance` from `packages/mcp`, through npm's
  [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts the Release job's
  GitHub OIDC token instead of a stored token, and attaches a provenance statement. It needs npm
  11.5.1+ and Node 22.14+, which the job sets up. `prepublishOnly` builds `dist/` and runs the
  package's tests first.
- **MCP registry**: `mcp-publisher login github-oidc` then `mcp-publisher publish` from
  `packages/mcp`. The OIDC token from a BoltCreative repository's workflow grants the
  `io.github.BoltCreative/*` namespace. The registry checks that `server.json`'s `name` matches
  `mcpName` in `package.json` and that the npm version exists, which is why it runs after npm. The
  job pins `mcp-publisher` (`MCP_PUBLISHER_VERSION`) and verifies its Sigstore signature; bump the
  pin deliberately.

Check the listing with
`curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.BoltCreative/tab-hammer"`.

### One-time npm setup: the trusted publisher

The package must exist on npm first (it does: `tab-hammer-mcp@0.1.0` was published by hand). On
[npmjs.com](https://www.npmjs.com/package/tab-hammer-mcp), open **tab-hammer-mcp → Settings →
Trusted publisher**, choose **GitHub Actions**, and enter:

| Field             | Value         |
| ----------------- | ------------- |
| Organization      | `BoltCreative` |
| Repository        | `tab-hammer`  |
| Workflow filename | `release.yml` |
| Environment       | (blank)       |

npm doesn't check these when you save them; a mistake only shows when Release's npm part fails to
publish. The `repository.url` in `packages/mcp/package.json` must match this repository. Once it
works, you can set the package's **Publishing access** to require two-factor authentication and
disallow tokens, so only Release can publish.

The MCP registry needs no setup.

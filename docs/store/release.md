# Cutting a release

How to publish a new version of Tab Hammer to the Chrome Web Store.

1. **Bump the version** from a clean branch:

   ```
   npm run release -- patch      # or minor, major, or an exact version like 1.4.0
   ```

   This sets the version in `packages/extension/src/manifest.ts` (what Chrome and the store read),
   every `package.json`, `package-lock.json`, and the MCP registry listing (`packages/mcp/server.json`). It refuses a version that isn't above the current
   one, and commits and tags nothing.

2. **Run the gate:** `npm run gate`. It must pass.

3. **Commit and tag** the bump, and land it through a PR as usual:

   ```
   git commit -am "chore: release 1.4.0"
   git tag v1.4.0
   ```

4. **Build the store package:** `npm run build:store`. It builds into
   `packages/extension/dist-store/` and writes `packages/extension/release/tab-hammer-<version>.zip`.

   The store build differs from the dev build in two ways. It has no manifest `key` (the store
   rejects one and assigns its own extension ID), and it signs in to Drive with
   `STORE_GOOGLE_OAUTH_CLIENT_ID` from `packages/extension/src/shared/syncConfig.ts`, not the dev
   client (an OAuth client only works for one extension ID). While that constant is empty, the store
   build ships with Drive sync off. The script fails if the zip's manifest still has a `key` or the
   dev client.

5. **Upload** the zip in the Chrome Web Store developer dashboard (Package → Upload new package),
   check the listing still matches `docs/store/listing.md` (especially the permission
   justifications, if the manifest's permissions changed), and submit for review.

## First release only

- Create the item by uploading the first zip; the store then shows the item's extension ID. Put
  it in `STORE_EXTENSION_ID` (`packages/protocol/src/index.ts`) so the MCP installer allows the
  store build to reach the native host, and publish the MCP package (below).
- Create a Google Cloud OAuth client of type "Chrome extension" for that ID (same project as the
  dev client, Drive API enabled), put its client ID in `STORE_GOOGLE_OAUTH_CLIENT_ID`, and release
  again to turn on Drive sync in the store build.
- Publish `docs/store/privacy-policy.md` with GitHub Pages and paste its address into the
  dashboard's privacy tab, then fill in the rest from `docs/store/listing.md`.

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


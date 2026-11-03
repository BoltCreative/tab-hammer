# Tab Hammer — project instructions

Tab Hammer is a Manifest V3 Chrome extension (TypeScript + React + Vite) that shows every Chrome window, tab group, and tab as an outline in its own window, plus an MCP server that lets Claude Code read and rearrange tabs through the extension. It's an npm workspaces monorepo: `packages/extension` (the extension), `packages/mcp` (MCP server and native messaging host), `packages/protocol` (message types both compile against). Global CLAUDE.md owns workstyle, worktrees, and parallel-dev rules; this file adds Tab Hammer specifics.

## Launch Claude from the repo root

Always launch Claude in the repo root, not from a worktree directory — Claude Code resolves `.claude/` settings and skills from where it starts. Create and enter worktrees from there.

## Worktree setup

After `git worktree add`, run `npm install` at the worktree root. A fresh worktree has no `node_modules/`, and Node's resolver silently walks up to the main checkout's instead of failing.

## Docs

- Design specs: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

## Completion gates

Pick the gate by change class. Report the gate name and result when declaring work complete.

| Gate            | Command        | When                                                                                                                      |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Docs-only diff  | (none)         | Every changed path is `.md`.                                                                                              |
| Any code change | `npm run gate` | typecheck + lint + format check + unit (Vitest) + `build:e2e` + e2e (Playwright, real Chromium with the built extension). |

Run it once on the final commit. The e2e suite launches its own throwaway Chromium profile; it never touches the user's Chrome.

The gate builds into `packages/extension/dist-e2e/` (`npm run build:e2e`), and the e2e fixture loads the extension from there. `~/.tab-hammer/dist` belongs to the user: every tree's `npm run dev` server writes it and their Chrome loads it, so never build into it from a gate or test run, and never run `npm run dev` yourself. `dist/` is only the `npm run build` output. To run e2e alone, `npm run build:e2e` first; pass Playwright arguments after `--` (`npm run test:e2e -- tests/e2e/bridge.spec.ts`). `build:e2e` builds with `--mode e2e`, which skips `chrome.tabs.discard` (the lazy-reopen step) because headless Chromium crashes moments after any discard.

Never run `npm run install-mcp` yourself: it writes into the user's Chrome profile folders and their Claude Code config. Tests deploy the native host into their own temp folder.

The e2e suite runs headless (new-headless Chromium). Headless Chromium ignores window focus changes, so window focus is asserted via recorded `chrome.windows.update` calls rather than by observing which window is focused. It must stay headless: the user works on this machine while gates run, and headed windows steal their workspace.

## Architecture in one breath

Extension paths below are relative to `packages/extension/`.

A service worker opens or focuses the Tab Hammer popup window, and screenshots each window's visible tab as the user browses (`src/background/previews.ts`) into an IndexedDB store keyed by page URL (`src/shared/previewStore.ts`), which the view reads for the tab hover card. When the hover card opens for a tab with no preview (or a stale one), the view asks the service worker to capture it on demand: background tabs are screenshotted through `chrome.debugger` and CDP `Page.captureScreenshot`, attached only for the shot (`src/background/debuggerCapture.ts`, one at a time through `captureQueue.ts`). It also records each window's and each on-demand tab's latest capture outcome (saved, or which rule skipped it, or the error) in `chrome.storage.session` (`src/shared/captureOutcomes.ts`); the hover card shows it when a tab has no preview. The header's Refresh stale / Refresh all buttons run the same on-demand captures for every tab, one at a time, from the view (`src/view/refresh/`). Clearing Chrome's history deletes the matching previews (`history.onVisitRemoved` in `previews.ts`). The view page reads Chrome's live windows, tabs, and groups (`src/view/chrome/chromeSource.ts`, the only view module that touches `chrome.*`). It feeds them through two pure, unit-tested modules: `src/model/buildTree.ts` (raw data → window/group/tab view model) and `src/model/selection.ts` (multi-select reducer). Then it renders React components. The view has a fixed header above the outline, and only the outline list scrolls: toolbar and action buttons (like the Clear previews debug button) and banners go in that header (`src/view/header/AppHeader.tsx`), never in the scrolling list. In `npm run dev`, crxjs's service worker forwards every request to the extension's own origin to the Vite server; `build/faviconPassthrough.ts` exempts Chrome's `_favicon/` endpoint, and any other Chrome-served extension URL would need the same. crxjs also reloads the whole extension whenever a file the service worker imports changes; `build/holdBrokenReloads.ts` holds that reload while the service worker's files don't link (a half-finished edit), since a service worker that fails to start takes crxjs's reload client down with it and the extension stays dead until reloaded by hand. Chrome window and tab IDs are not stable across restarts, so persistence (post-MVP) must introduce Tab Hammer's own node IDs.

Claude bridge: Claude Code starts the MCP server (`packages/mcp/src/main.ts`, stdio). Chrome starts the native messaging host (`packages/mcp/src/host.ts`) when the service worker connects (`src/background/bridge.ts`, at startup and on toolbar click; it retries with backoff if the host exits, and stops if the host isn't installed). The two meet on a Unix socket (`~/.tab-hammer/bridge.sock`; `TAB_HAMMER_SOCKET` overrides it). The host only relays, rewriting request IDs so several Claude sessions can share one Chrome connection; the service worker runs each command (`src/background/tabCommands.ts`). Chrome runs a deployed copy of the host from `~/.tab-hammer/native-host` (`packages/mcp/src/deploy.ts`), never the repo: macOS blocks Chrome-launched programs from reading `~/Documents` until the user approves a prompt, so a host run from the repo hangs silently. Keep `host.ts` and what it imports free of npm packages, and list every file it needs in `deploy.ts`. `packages/mcp` runs as TypeScript directly on Node 22.18+ (type stripping): erasable syntax only, `.ts` import extensions.

## Tests

- Unit: `packages/*/src/**/__tests__/` (and `packages/extension/build/__tests__/` for the Vite plugin, run against the installed crxjs). Extension: (model, capture scheduling, per-window and on-demand debugger capture with an injected `chrome`, the capture queue, preview policy, hover card logic), pure logic only. MCP: native messaging framing, plus a functional test running the real MCP server process against the real relay with a stand-in extension.
- E2E: `packages/extension/tests/e2e/`. `bridge.spec.ts` covers the whole Claude → Chrome path: it deploys the native host into a temp Chromium profile's `NativeMessagingHosts` folder, lets Chromium launch it, and drives tab commands through the real MCP server. The fixture opens the view through the service worker's `tabHammer.openOrFocus` test hook, the same code path as the toolbar click. Chrome refuses to screenshot `data:` pages, so preview tests serve http pages through Playwright's `context.route`. Routes only apply once Playwright has attached to a tab, so background tabs the service worker opens must start on a placeholder and navigate after (`openBackgroundTabs` in `preview.spec.ts`), or they silently load Chrome's error page.

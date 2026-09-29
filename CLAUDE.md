# Tab Hammer — project instructions

Tab Hammer is a Manifest V3 Chrome extension (TypeScript + React + Vite) that shows every Chrome window, tab group, and tab as an outline in its own window. Global CLAUDE.md owns workstyle, worktrees, and parallel-dev rules; this file adds Tab Hammer specifics.

## Launch Claude from the repo root

Always launch Claude in the repo root, not from a worktree directory — Claude Code resolves `.claude/` settings and skills from where it starts. Create and enter worktrees from there.

## Worktree setup

After `git worktree add`, run `npm install` at the worktree root. A fresh worktree has no `node_modules/`, and Node's resolver silently walks up to the main checkout's instead of failing.

## Docs

- Design specs: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

## Completion gates

Pick the gate by change class. Report the gate name and result when declaring work complete.

| Gate            | Command        | When                                                                                                                |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Docs-only diff  | (none)         | Every changed path is `.md`.                                                                                        |
| Any code change | `npm run gate` | typecheck + lint + format check + unit (Vitest) + build + e2e (Playwright, real Chromium with the built extension). |

Run it once on the final commit. The e2e suite launches its own throwaway Chromium profile; it never touches the user's Chrome.

The e2e suite runs headless (new-headless Chromium). Headless Chromium ignores window focus changes, so window focus is asserted via recorded `chrome.windows.update` calls rather than by observing which window is focused. It must stay headless: the user works on this machine while gates run, and headed windows steal their workspace.

## Architecture in one breath

A service worker opens or focuses the Tab Hammer popup window, and screenshots each window's visible tab as the user browses (`src/background/previews.ts`) into an IndexedDB store keyed by page URL (`src/shared/previewStore.ts`), which the view reads for the tab hover card. The view page reads Chrome's live windows, tabs, and groups (`src/view/chrome/chromeSource.ts`, the only view module that touches `chrome.*`). It feeds them through two pure, unit-tested modules: `src/model/buildTree.ts` (raw data → window/group/tab view model) and `src/model/selection.ts` (multi-select reducer). Then it renders React components. Chrome window and tab IDs are not stable across restarts, so persistence (post-MVP) must introduce Tab Hammer's own node IDs.

## Tests

- Unit: `src/**/__tests__/` (model, capture scheduling and per-window capture with an injected `chrome`, preview policy, hover card logic). Pure logic only.
- E2E: `tests/e2e/`. The fixture opens the view through the service worker's `tabHammer.openOrFocus` test hook, the same code path as the toolbar click. Chrome refuses to screenshot `data:` pages, so preview tests serve http pages through Playwright's `context.route`.

# Contributing to Tab Hammer

Thanks for helping out. Bug reports, feature ideas, and pull requests are all welcome; for
anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

You need:

- **Node.js 22.18 or newer** (the MCP server runs TypeScript directly through Node's type
  stripping), and npm.
- **Google Chrome** (or Chromium) for trying the extension.

```
npm install
npx playwright install chromium
```

The second command downloads the Chromium build that the end-to-end tests drive (the version
matching the repo's `@playwright/test`). On Linux, add `--with-deps` to install its system
libraries too.

If you work in a git worktree, run `npm install` in the worktree itself. Otherwise Node silently
resolves the main checkout's `node_modules/`.

## Dev loop

```
npm run dev
```

This writes the extension to `~/.tab-hammer/dist` and rebuilds it on save (set
`TAB_HAMMER_DEV_DIR` to use another folder). In Chrome, open `chrome://extensions`, turn on
Developer mode, choose **Load unpacked**, and select that folder. Most changes then reload the
running extension on their own. The manifest's fixed `key` gives the extension the same ID
wherever it's built, so its storage and previews survive switching between checkouts.

Other useful commands:

| Command             | What it does                                                 |
| ------------------- | ------------------------------------------------------------ |
| `npm test`          | Unit tests (Vitest) for every package.                       |
| `npm run build:e2e` | Builds the extension into `packages/extension/dist-e2e/`.    |
| `npm run test:e2e`  | End-to-end tests against that build (run `build:e2e` first). |
| `npm run typecheck` | TypeScript, every package.                                   |
| `npm run lint`      | ESLint.                                                      |
| `npm run format`    | Prettier, writing fixes.                                     |
| `npm run build`     | A production build into `packages/extension/dist/`.          |

Pass Playwright arguments after `--`, for example
`npm run test:e2e -- tests/e2e/bridge.spec.ts`.

## The gate

Every code change must pass:

```
npm run gate
```

It runs the typechecker, linter, format check, unit tests, the e2e build, and the end-to-end
suite. The e2e suite runs Chromium headless with a throwaway profile, so it never touches your
own Chrome and doesn't open windows over your work. CI runs the same gate on every pull request.

Tests should earn their place: prefer end-to-end and integration tests that exercise real
behavior, and keep unit tests for pure logic with real edge cases. No sleeps or arbitrary
timeouts; wait on the condition you need (`expect.poll`, locators).

## Pull requests

- Open PRs against `dev`. `main` only takes `dev` (a CI check enforces it); merging to `main`
  only runs CI, and a maintainer releases by hand. A maintainer's approval is required to merge
  into `dev`.
- Keep each PR focused on one change, and describe what it does and why.
- Run `npm run gate` and say so in the PR. Docs-only changes don't need it.
- Add or update tests for behavior you change.
- Update [AGENTS.md](AGENTS.md) if you change something it describes (architecture, test hooks,
  gates).
- For substantial new work, add a design spec under `docs/superpowers/specs/` and, if useful, a
  plan under `docs/superpowers/plans/`. The existing ones are historical records of earlier
  designs, not a description of the current code.

## AI coding agents

[AGENTS.md](AGENTS.md) is the project guide for AI agents (and a good architecture overview for
humans). `CLAUDE.md` imports it, so Claude Code picks it up automatically.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

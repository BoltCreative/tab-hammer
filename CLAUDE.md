# Tab Hammer — project instructions

Tab Hammer is a Manifest V3 Chrome extension (TypeScript + React + Vite) that shows every Chrome window, tab group, and tab as an outline in its own window. Global CLAUDE.md owns workstyle, worktrees, and parallel-dev rules; this file adds Tab Hammer specifics.

## Launch Claude from the repo root

Always launch Claude in the repo root, not from a worktree directory — Claude Code resolves `.claude/` settings and skills from where it starts. Create and enter worktrees from there.

## Worktree setup

After `git worktree add`, run `npm install` at the worktree root. A fresh worktree has no `node_modules/`, and Node's resolver silently walks up to the main checkout's instead of failing.

## Docs

- Design specs: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

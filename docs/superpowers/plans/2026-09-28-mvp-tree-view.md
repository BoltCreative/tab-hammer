# Tab Hammer MVP Tree View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension that opens its own popup window and shows every Chrome window, tab group, and tab as a live, read-only outline, with multi-select and double-click-to-activate.

**Architecture:** A tiny service worker opens or focuses the view window. The view page (React) queries `chrome.windows` / `chrome.tabs` / `chrome.tabGroups` directly, subscribes to their events, and re-renders. Two pure modules sit between Chrome and React. `buildTree` turns raw Chrome data into a view model. `selection` is a reducer for click / toggle / range selection. Both are unit-tested. One Playwright suite exercises the real extension in Chromium.

**Tech Stack:** TypeScript 6.0 (strict), React 19, Vite 8 + `@crxjs/vite-plugin` 3, Vitest 5, Playwright 1.63, ESLint 10 flat config + typescript-eslint 8, Prettier 3. npm.

**Spec:** `docs/superpowers/specs/2026-09-28-mvp-tree-view-design.md`

## Global Constraints

- Manifest V3. Permissions exactly: `tabs`, `tabGroups`, `storage`, `favicon`. No host permissions, no content scripts, `action` has no `default_popup`.
- The view opens with `chrome.windows.create({ type: 'popup' })`, never a side panel.
- Hierarchy is only window → tab group → tab. Never nest tabs by opener.
- Read-only: nothing in the UI closes, moves, or regroups tabs, or changes Chrome's group collapsed state. The only Chrome mutations are activating a tab and focusing a window.
- Single click = select only. Cmd/Ctrl-click = toggle. Shift-click = range over visible rows. Double-click tab = activate the tab AND focus its window. Double-click window header = focus the window.
- Dark theme. Window cards. Group header rows in the Chrome group color, with the group's tabs indented beneath.
- TypeScript must stay on `~6.0` (typescript-eslint 8.71 supports `<6.1`).
- Component files stay well under 200 lines. Colors are defined as CSS custom properties.
- Tests never use sleeps or arbitrary timeouts; they wait on concrete conditions.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
package.json, tsconfig.json, vite.config.ts, eslint.config.js, .prettierrc, .prettierignore
vitest.config.ts, playwright.config.ts
src/manifest.ts                    MV3 manifest (defineManifest)
src/background/index.ts            service worker: open-or-focus the view window
src/model/types.ts                 Raw* input types + *Node view-model types
src/model/buildTree.ts             pure: RawSnapshot -> WindowNode[]
src/model/visibleRows.ts           pure: tree + collapse state -> ordered visible row keys
src/model/selection.ts             pure reducer: click / toggle / range / prune
src/model/__tests__/*.test.ts      Vitest unit tests
src/view/index.html                view page entry
src/view/main.tsx                  React root
src/view/App.tsx                   state wiring (snapshot, selection, collapse)
src/view/chrome/chromeSource.ts    the ONLY view module touching chrome.*
src/view/chrome/favicon.ts         _favicon URL helper
src/view/components/WindowCard.tsx
src/view/components/GroupRow.tsx
src/view/components/TabRow.tsx
src/view/components/rowClick.ts    maps mouse events to selection actions
src/view/styles/theme.css          dark palette + group color tokens
tests/e2e/fixtures.ts              Playwright fixture: Chromium with the built extension
tests/e2e/tree.spec.ts             end-to-end tests
```

---

### Task 1: Project scaffold, manifest, and service worker

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `src/manifest.ts`, `src/background/index.ts`, `src/view/index.html`, `src/view/main.tsx`, `src/view/App.tsx` (placeholder), `src/vite-env.d.ts`

**Interfaces:**
- Produces: `VIEW_PATH = 'src/view/index.html'` (exported from `src/background/index.ts`). This is the path the view page has in `dist/`. `globalThis.tabHammer.openOrFocus()` is exposed in the service worker so the E2E suite can trigger the toolbar-click behavior.

- [ ] **Step 1: Install dependencies**

```bash
npm init -y
npm pkg set name=tab-hammer private=true type=module version=0.1.0
npm install react@^19 react-dom@^19
npm install -D typescript@~6.0 vite@^8 @vitejs/plugin-react@^6 @crxjs/vite-plugin@^3 \
  @types/react@^19 @types/react-dom@^19 @types/chrome \
  vitest@^5 @playwright/test@^1.63 \
  eslint@^10 @eslint/js typescript-eslint@^8 eslint-plugin-react-hooks@^7 globals \
  prettier@^3
npx playwright install chromium
```

Then set the scripts:

```bash
npm pkg set scripts.dev="vite" \
  scripts.build="vite build" \
  scripts.typecheck="tsc --noEmit" \
  scripts.lint="eslint ." \
  scripts.format="prettier --write ." \
  scripts.format:check="prettier --check ." \
  scripts.test="vitest run" \
  scripts.test:e2e="playwright test" \
  scripts.gate="npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run test:e2e"
```

(`test:e2e` depends on `dist/` from `build`. The gate runs them in that order.)

- [ ] **Step 2: Write config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client"],
    "noEmit": true
  },
  "include": ["src", "tests", "*.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: { view: 'src/view/index.html' },
    },
  },
  server: { port: 5174, strictPort: true },
});
```

`src/manifest.ts`:
```ts
import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Hammer',
  version: '0.1.0',
  description: 'Every window, group, and tab as a live outline in its own window.',
  permissions: ['tabs', 'tabGroups', 'storage', 'favicon'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_title: 'Open Tab Hammer' },
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
```

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', '.worktrees/', '.superpowers/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

`.prettierignore`:
```
dist
node_modules
test-results
playwright-report
package-lock.json
.worktrees
.superpowers
```

`src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

**Verify before relying on it:** check `node_modules/@crxjs/vite-plugin` (its README or `.d.ts`) to confirm `defineManifest` and `crx({ manifest })` are still the v3 API. Also confirm how extra HTML inputs are emitted, i.e. that `dist/src/view/index.html` exists after the build. If the API or the output path differs, adapt the config and `VIEW_PATH` and note the deviation in the commit message.

- [ ] **Step 3: Write the service worker**

`src/background/index.ts`:
```ts
export const VIEW_PATH = 'src/view/index.html';

async function openOrFocus(): Promise<void> {
  const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
  if (typeof viewWindowId === 'number') {
    try {
      await chrome.windows.update(viewWindowId, { focused: true });
      return;
    } catch {
      // The stored window was closed; fall through and open a new one.
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(VIEW_PATH),
    type: 'popup',
    width: 420,
    height: 820,
  });
  await chrome.storage.session.set({ viewWindowId: win?.id });
}

chrome.action.onClicked.addListener(() => {
  void openOrFocus();
});

// Test hook: Playwright can't click the toolbar icon, so E2E calls this directly.
(globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }).tabHammer = {
  openOrFocus,
};
```

- [ ] **Step 4: Write the placeholder view**

`src/view/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Tab Hammer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/view/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/view/App.tsx`:
```tsx
export function App() {
  return <main>Tab Hammer</main>;
}
```

- [ ] **Step 5: Verify the build and static checks**

Run: `npm run build && ls dist/src/view/index.html dist/manifest.json && npm run typecheck && npm run lint && npm run format:check`
Expected: all succeed. `dist/manifest.json` contains `"service_worker"` and the four permissions. (Run `npm run format` first if the format check flags the new files.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Scaffold MV3 extension with Vite, React, and open-or-focus service worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: View model types and `buildTree`

**Files:**
- Create: `src/model/types.ts`, `src/model/buildTree.ts`
- Test: `src/model/__tests__/buildTree.test.ts`

**Interfaces:**
- Produces (exact):

```ts
// src/model/types.ts
export type GroupColor =
  | 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface RawWindow { id: number; focused: boolean }
export interface RawTab {
  id: number; windowId: number; index: number; groupId: number; // -1 = ungrouped
  title?: string; url?: string; pendingUrl?: string;
  active: boolean; discarded: boolean;
}
export interface RawGroup { id: number; windowId: number; title?: string; color: GroupColor; collapsed: boolean }
export interface RawSnapshot {
  windows: RawWindow[]; tabs: RawTab[]; groups: RawGroup[];
  selfWindowId: number | null; // Tab Hammer's own window, excluded from the tree
}

export interface TabNode {
  kind: 'tab'; key: string; // `t:${tabId}`
  tabId: number; windowId: number; title: string; url: string;
  active: boolean; discarded: boolean;
}
export interface GroupNode {
  kind: 'group'; key: string; // `g:${groupId}:${firstTabId}`, unique even for split runs
  groupId: number; title: string; color: GroupColor; chromeCollapsed: boolean; tabs: TabNode[];
}
export interface WindowNode {
  kind: 'window'; key: string; // `w:${windowId}`
  windowId: number; label: string; focused: boolean; tabCount: number;
  children: (GroupNode | TabNode)[];
}
```

```ts
// src/model/buildTree.ts
export function buildTree(snapshot: RawSnapshot): WindowNode[];
```

- [ ] **Step 1: Write the types file** (content above, formatted by Prettier).

- [ ] **Step 2: Write the failing tests**

`src/model/__tests__/buildTree.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import type { RawGroup, RawSnapshot, RawTab } from '../types';

const tab = (id: number, windowId: number, index: number, extra: Partial<RawTab> = {}): RawTab => ({
  id, windowId, index, groupId: -1, title: `Tab ${id}`, url: `https://example.com/${id}`,
  active: false, discarded: false, ...extra,
});
const group = (id: number, windowId: number, extra: Partial<RawGroup> = {}): RawGroup => ({
  id, windowId, title: `Group ${id}`, color: 'blue', collapsed: false, ...extra,
});
const snap = (s: Partial<RawSnapshot>): RawSnapshot => ({
  windows: [], tabs: [], groups: [], selfWindowId: null, ...s,
});

describe('buildTree', () => {
  it('lists windows in given order with 1-based labels, tabs sorted by index', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }, { id: 20, focused: true }],
      tabs: [tab(2, 10, 1), tab(1, 10, 0), tab(3, 20, 0)],
    }));
    expect(tree.map((w) => [w.label, w.focused, w.tabCount])).toEqual([
      ['Window 1', false, 2], ['Window 2', true, 1],
    ]);
    expect(tree[0]!.children.map((c) => c.key)).toEqual(['t:1', 't:2']);
  });

  it('excludes the Tab Hammer window and renumbers the rest', () => {
    const tree = buildTree(snap({
      windows: [{ id: 99, focused: true }, { id: 10, focused: false }],
      tabs: [tab(1, 99, 0), tab(2, 10, 0)],
      selfWindowId: 99,
    }));
    expect(tree.map((w) => [w.windowId, w.label])).toEqual([[10, 'Window 1']]);
  });

  it('wraps consecutive grouped tabs in a GroupNode, keeping ungrouped tabs at top level', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }],
      tabs: [tab(1, 10, 0, { groupId: 5 }), tab(2, 10, 1, { groupId: 5 }), tab(3, 10, 2)],
      groups: [group(5, 10, { title: 'Research', color: 'red', collapsed: true })],
    }));
    const [g, t] = tree[0]!.children;
    expect(g).toMatchObject({
      kind: 'group', key: 'g:5:1', title: 'Research', color: 'red', chromeCollapsed: true,
    });
    expect(g!.kind === 'group' && g.tabs.map((x) => x.key)).toEqual(['t:1', 't:2']);
    expect(t).toMatchObject({ kind: 'tab', key: 't:3' });
    expect(tree[0]!.tabCount).toBe(3);
  });

  it('gives each run of a split group its own GroupNode with a unique key', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }],
      tabs: [tab(1, 10, 0, { groupId: 5 }), tab(2, 10, 1), tab(3, 10, 2, { groupId: 5 })],
      groups: [group(5, 10)],
    }));
    expect(tree[0]!.children.map((c) => c.key)).toEqual(['g:5:1', 't:2', 'g:5:3']);
  });

  it('labels an untitled group and falls back from title to url to pendingUrl', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }],
      tabs: [
        tab(1, 10, 0, { groupId: 5, title: '', url: 'https://a.test/' }),
        tab(2, 10, 1, { title: undefined, url: undefined, pendingUrl: 'https://b.test/' }),
      ],
      groups: [group(5, 10, { title: '' })],
    }));
    const [g, t] = tree[0]!.children;
    expect(g!.kind === 'group' && g.title).toBe('Untitled group');
    expect(g!.kind === 'group' && g.tabs[0]!.title).toBe('https://a.test/');
    expect(t!.kind === 'tab' && [t.title, t.url]).toEqual(['https://b.test/', 'https://b.test/']);
  });

  it('carries active and discarded flags', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }],
      tabs: [tab(1, 10, 0, { active: true }), tab(2, 10, 1, { discarded: true })],
    }));
    expect(tree[0]!.children).toMatchObject([
      { active: true, discarded: false }, { active: false, discarded: true },
    ]);
  });

  it('treats a tab whose group is missing from the snapshot as ungrouped', () => {
    const tree = buildTree(snap({
      windows: [{ id: 10, focused: false }],
      tabs: [tab(1, 10, 0, { groupId: 77 })],
    }));
    expect(tree[0]!.children).toMatchObject([{ kind: 'tab', key: 't:1' }]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/model/__tests__/buildTree.test.ts`
Expected: FAIL (cannot resolve `../buildTree`).

- [ ] **Step 4: Implement `buildTree`**

`src/model/buildTree.ts`:
```ts
import type { GroupNode, RawGroup, RawSnapshot, RawTab, TabNode, WindowNode } from './types';

function toTabNode(t: RawTab): TabNode {
  const url = t.url || t.pendingUrl || '';
  return {
    kind: 'tab', key: `t:${t.id}`, tabId: t.id, windowId: t.windowId,
    title: t.title || url, url, active: t.active, discarded: t.discarded,
  };
}

export function buildTree(snapshot: RawSnapshot): WindowNode[] {
  const groups = new Map<number, RawGroup>(snapshot.groups.map((g) => [g.id, g]));
  const tabsByWindow = new Map<number, RawTab[]>();
  for (const t of snapshot.tabs) {
    const list = tabsByWindow.get(t.windowId) ?? [];
    list.push(t);
    tabsByWindow.set(t.windowId, list);
  }

  return snapshot.windows
    .filter((w) => w.id !== snapshot.selfWindowId)
    .map((w, i) => {
      const tabs = (tabsByWindow.get(w.id) ?? []).slice().sort((a, b) => a.index - b.index);
      const children: (GroupNode | TabNode)[] = [];
      let run: GroupNode | null = null;
      for (const t of tabs) {
        const g = t.groupId === -1 ? undefined : groups.get(t.groupId);
        if (!g) {
          run = null;
          children.push(toTabNode(t));
          continue;
        }
        if (!run || run.groupId !== g.id) {
          run = {
            kind: 'group', key: `g:${g.id}:${t.id}`, groupId: g.id,
            title: g.title || 'Untitled group', color: g.color,
            chromeCollapsed: g.collapsed, tabs: [],
          };
          children.push(run);
        }
        run.tabs.push(toTabNode(t));
      }
      return {
        kind: 'window', key: `w:${w.id}`, windowId: w.id, label: `Window ${i + 1}`,
        focused: w.focused, tabCount: tabs.length, children,
      };
    });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/model/__tests__/buildTree.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Format, lint, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add -A
git commit -m "Add buildTree view model for windows, tab groups, and tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Visible rows and the selection reducer

**Files:**
- Create: `src/model/visibleRows.ts`, `src/model/selection.ts`
- Test: `src/model/__tests__/visibleRows.test.ts`, `src/model/__tests__/selection.test.ts`

**Interfaces:**
- Consumes: `WindowNode`, `GroupNode` from `src/model/types.ts` (Task 2).
- Produces (exact):

```ts
// src/model/visibleRows.ts
export interface CollapseState {
  collapsedWindows: ReadonlySet<string>;          // window keys the user collapsed in Tab Hammer
  groupOverrides: ReadonlyMap<string, boolean>;   // group key -> collapsed; absent = use chromeCollapsed
}
export function isGroupCollapsed(g: GroupNode, c: CollapseState): boolean;
export function visibleRowKeys(tree: WindowNode[], c: CollapseState): string[];
export function allRowKeys(tree: WindowNode[]): Set<string>;

// src/model/selection.ts
export interface SelectionState { selected: ReadonlySet<string>; anchor: string | null }
export type SelectionAction =
  | { type: 'click'; key: string }
  | { type: 'toggle'; key: string }
  | { type: 'range'; key: string; visible: readonly string[] }
  | { type: 'prune'; existing: ReadonlySet<string> };
export const emptySelection: SelectionState;
export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState;
```

- [ ] **Step 1: Write failing tests**

`src/model/__tests__/visibleRows.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { allRowKeys, visibleRowKeys, type CollapseState } from '../visibleRows';
import type { WindowNode } from '../types';

const t = (id: number) => ({
  kind: 'tab' as const, key: `t:${id}`, tabId: id, windowId: 1, title: '', url: '',
  active: false, discarded: false,
});
const tree: WindowNode[] = [
  {
    kind: 'window', key: 'w:1', windowId: 1, label: 'Window 1', focused: false, tabCount: 3,
    children: [
      { kind: 'group', key: 'g:5:1', groupId: 5, title: 'G', color: 'blue', chromeCollapsed: true, tabs: [t(1), t(2)] },
      t(3),
    ],
  },
  { kind: 'window', key: 'w:2', windowId: 2, label: 'Window 2', focused: false, tabCount: 1, children: [t(4)] },
];
const none: CollapseState = { collapsedWindows: new Set(), groupOverrides: new Map() };

describe('visibleRowKeys', () => {
  it('hides tabs of a group Chrome reports collapsed', () => {
    expect(visibleRowKeys(tree, none)).toEqual(['w:1', 'g:5:1', 't:3', 'w:2', 't:4']);
  });
  it('a local override expands a Chrome-collapsed group', () => {
    const c = { ...none, groupOverrides: new Map([['g:5:1', false]]) };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'g:5:1', 't:1', 't:2', 't:3', 'w:2', 't:4']);
  });
  it('a collapsed window shows only its header', () => {
    const c = { ...none, collapsedWindows: new Set(['w:1']) };
    expect(visibleRowKeys(tree, c)).toEqual(['w:1', 'w:2', 't:4']);
  });
  it('allRowKeys includes hidden rows', () => {
    expect(allRowKeys(tree)).toEqual(new Set(['w:1', 'g:5:1', 't:1', 't:2', 't:3', 'w:2', 't:4']));
  });
});
```

`src/model/__tests__/selection.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emptySelection, selectionReducer as r, type SelectionState } from '../selection';

const keys = (s: SelectionState) => [...s.selected].sort();
const visible = ['w:1', 't:1', 't:2', 't:3', 'w:2', 't:4'];

describe('selectionReducer', () => {
  it('click selects only that row and sets the anchor', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:1' }), { type: 'click', key: 't:2' });
    expect(keys(s)).toEqual(['t:2']);
    expect(s.anchor).toBe('t:2');
  });
  it('toggle adds and removes without clearing others', () => {
    let s = r(emptySelection, { type: 'click', key: 't:1' });
    s = r(s, { type: 'toggle', key: 't:3' });
    expect(keys(s)).toEqual(['t:1', 't:3']);
    s = r(s, { type: 'toggle', key: 't:1' });
    expect(keys(s)).toEqual(['t:3']);
    expect(s.anchor).toBe('t:1');
  });
  it('range selects visible rows between anchor and target, in either direction', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:3' }), { type: 'range', key: 't:1', visible });
    expect(keys(s)).toEqual(['t:1', 't:2', 't:3']);
    expect(s.anchor).toBe('t:3');
  });
  it('range can span windows', () => {
    const s = r(r(emptySelection, { type: 'click', key: 't:2' }), { type: 'range', key: 't:4', visible });
    expect(keys(s)).toEqual(['t:2', 't:3', 't:4', 'w:2']);
  });
  it('range with no visible anchor behaves like click', () => {
    const s = r(emptySelection, { type: 'range', key: 't:2', visible });
    expect(keys(s)).toEqual(['t:2']);
    expect(s.anchor).toBe('t:2');
  });
  it('prune drops keys that no longer exist and clears a vanished anchor', () => {
    let s = r(emptySelection, { type: 'click', key: 't:1' });
    s = r(s, { type: 'toggle', key: 't:2' });
    s = r(s, { type: 'prune', existing: new Set(['t:1']) });
    expect(keys(s)).toEqual(['t:1']);
    expect(s.anchor).toBeNull();
  });
  it('prune returns the same object when nothing changed', () => {
    const s = r(emptySelection, { type: 'click', key: 't:1' });
    expect(r(s, { type: 'prune', existing: new Set(['t:1']) })).toBe(s);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/model/__tests__/visibleRows.test.ts src/model/__tests__/selection.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/model/visibleRows.ts`:
```ts
import type { GroupNode, WindowNode } from './types';

export interface CollapseState {
  collapsedWindows: ReadonlySet<string>;
  groupOverrides: ReadonlyMap<string, boolean>;
}

export function isGroupCollapsed(g: GroupNode, c: CollapseState): boolean {
  return c.groupOverrides.get(g.key) ?? g.chromeCollapsed;
}

export function visibleRowKeys(tree: WindowNode[], c: CollapseState): string[] {
  const out: string[] = [];
  for (const w of tree) {
    out.push(w.key);
    if (c.collapsedWindows.has(w.key)) continue;
    for (const child of w.children) {
      out.push(child.key);
      if (child.kind === 'group' && !isGroupCollapsed(child, c)) {
        for (const t of child.tabs) out.push(t.key);
      }
    }
  }
  return out;
}

export function allRowKeys(tree: WindowNode[]): Set<string> {
  const out = new Set<string>();
  for (const w of tree) {
    out.add(w.key);
    for (const child of w.children) {
      out.add(child.key);
      if (child.kind === 'group') for (const t of child.tabs) out.add(t.key);
    }
  }
  return out;
}
```

`src/model/selection.ts`:
```ts
export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export type SelectionAction =
  | { type: 'click'; key: string }
  | { type: 'toggle'; key: string }
  | { type: 'range'; key: string; visible: readonly string[] }
  | { type: 'prune'; existing: ReadonlySet<string> };

export const emptySelection: SelectionState = { selected: new Set(), anchor: null };

export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case 'click':
      return { selected: new Set([a.key]), anchor: a.key };
    case 'toggle': {
      const selected = new Set(s.selected);
      if (selected.has(a.key)) selected.delete(a.key);
      else selected.add(a.key);
      return { selected, anchor: a.key };
    }
    case 'range': {
      const from = s.anchor === null ? -1 : a.visible.indexOf(s.anchor);
      const to = a.visible.indexOf(a.key);
      if (from === -1 || to === -1) return { selected: new Set([a.key]), anchor: a.key };
      const [lo, hi] = from < to ? [from, to] : [to, from];
      return { selected: new Set(a.visible.slice(lo, hi + 1)), anchor: s.anchor };
    }
    case 'prune': {
      const selected = new Set([...s.selected].filter((k) => a.existing.has(k)));
      const anchor = s.anchor !== null && a.existing.has(s.anchor) ? s.anchor : null;
      if (selected.size === s.selected.size && anchor === s.anchor) return s;
      return { selected, anchor };
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run`
Expected: PASS (buildTree 7, visibleRows 4, selection 7).

- [ ] **Step 5: Format, lint, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add -A
git commit -m "Add visible-row flattening and multi-select reducer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Chrome data source and the view UI

No unit tests in this task: the pure logic is covered by Tasks 2–3, and the UI and Chrome wiring are covered end to end in Task 5. Verification here is typecheck, lint, and build.

**Files:**
- Create: `src/view/chrome/chromeSource.ts`, `src/view/chrome/favicon.ts`, `src/view/components/WindowCard.tsx`, `src/view/components/GroupRow.tsx`, `src/view/components/TabRow.tsx`, `src/view/components/rowClick.ts`, `src/view/styles/theme.css`
- Modify: `src/view/App.tsx` (replace the placeholder), `src/view/main.tsx` (import `./styles/theme.css`)

**Interfaces:**
- Consumes: `buildTree`, `visibleRowKeys`, `allRowKeys`, `isGroupCollapsed`, `CollapseState`, `selectionReducer`, `emptySelection`, and the types from Tasks 2–3.
- Produces: the DOM contract the E2E suite relies on. It is exact; do not rename:
  - every row element has `data-key="<row key>"` and `data-kind="window"|"group"|"tab"`
  - a selected row has `aria-selected="true"`, otherwise `"false"`
  - a window card is `<section data-testid="window-card">`, and its header row carries `data-key="w:<id>"`
  - tab rows show the title text inside `<span class="title">`

- [ ] **Step 1: Chrome source**

`src/view/chrome/chromeSource.ts`:
```ts
import type { GroupColor, RawSnapshot } from '../../model/types';

let selfWindowId: number | null = null;

export async function snapshot(): Promise<RawSnapshot> {
  if (selfWindowId === null) selfWindowId = (await chrome.windows.getCurrent()).id ?? null;
  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll(),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);
  return {
    selfWindowId,
    windows: windows.flatMap((w) => (w.id === undefined ? [] : [{ id: w.id, focused: w.focused }])),
    tabs: tabs.flatMap((t) =>
      t.id === undefined
        ? []
        : [{
            id: t.id, windowId: t.windowId, index: t.index, groupId: t.groupId,
            title: t.title, url: t.url, pendingUrl: t.pendingUrl,
            active: t.active, discarded: t.discarded,
          }],
    ),
    groups: groups.map((g) => ({
      id: g.id, windowId: g.windowId, title: g.title, color: g.color as GroupColor, collapsed: g.collapsed,
    })),
  };
}

type AnyEvent = { addListener(cb: () => void): void; removeListener(cb: () => void): void };

/** Calls onChange at most once per animation frame, however many Chrome events arrive. */
export function subscribe(onChange: () => void): () => void {
  let scheduled = false;
  const fire = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      onChange();
    });
  };
  const events: AnyEvent[] = [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved,
    chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onActivated, chrome.tabs.onReplaced,
    chrome.windows.onCreated, chrome.windows.onRemoved, chrome.windows.onFocusChanged,
    chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved,
    chrome.tabGroups.onMoved,
  ] as unknown as AnyEvent[];
  for (const e of events) e.addListener(fire);
  return () => events.forEach((e) => e.removeListener(fire));
}

export async function activateTab(tabId: number, windowId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
}

export async function focusWindow(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
}
```

`src/view/chrome/favicon.ts`:
```ts
export function faviconUrl(pageUrl: string): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '16');
  return u.toString();
}
```

- [ ] **Step 2: Theme**

`src/view/styles/theme.css`:
```css
:root {
  --bg: #17181b;
  --card: #212226;
  --card-border: #2c2d32;
  --card-border-focused: #3b4a6b;
  --text: #d4d6da;
  --text-strong: #e8e9ec;
  --text-muted: #6f737a;
  --row-hover: #2a2b30;
  --row-selected: #2b3a5c;
  --row-active-marker: #8ab4f8;
  --group-grey: #bdc1c6;
  --group-blue: #8ab4f8;
  --group-red: #f28b82;
  --group-yellow: #fdd663;
  --group-green: #81c995;
  --group-pink: #ff8bcb;
  --group-purple: #c58af9;
  --group-cyan: #78d9ec;
  --group-orange: #fcad70;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.3 -apple-system, system-ui, sans-serif; user-select: none;
}
main { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.card { background: var(--card); border: 1px solid var(--card-border); border-radius: 8px; padding: 6px; }
.card.focused { border-color: var(--card-border-focused); }
.row {
  display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 6px;
  border-radius: 5px; white-space: nowrap; overflow: hidden; cursor: default;
}
.row:hover { background: var(--row-hover); }
.row[aria-selected='true'] { background: var(--row-selected); color: #fff; }
.row .title { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.row .count { color: var(--text-muted); font-weight: 400; margin-left: auto; }
.window-header { font-size: 12px; font-weight: 600; color: var(--text-strong); }
.tab.active { box-shadow: inset 2px 0 0 var(--row-active-marker); font-weight: 500; }
.tab.discarded { color: var(--text-muted); }
.favicon { width: 14px; height: 14px; flex: none; border-radius: 3px; }
.favicon.placeholder { background: #3a3b40; }
.twisty { width: 12px; flex: none; color: var(--text-muted); text-align: center; }
.group-header { font-size: 11px; font-weight: 700; letter-spacing: 0.03em; color: var(--group-color); }
.group-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--group-color); flex: none; }
.group-tabs { margin-left: 12px; padding-left: 4px; border-left: 2px solid var(--group-color); }
```

- [ ] **Step 3: Row click mapping**

`src/view/components/rowClick.ts`:
```ts
import type { MouseEvent } from 'react';
import type { SelectionAction } from '../../model/selection';

export function selectionActionFor(
  e: MouseEvent,
  key: string,
  visible: readonly string[],
): SelectionAction {
  if (e.shiftKey) return { type: 'range', key, visible };
  if (e.metaKey || e.ctrlKey) return { type: 'toggle', key };
  return { type: 'click', key };
}
```

- [ ] **Step 4: Components**

`src/view/components/TabRow.tsx`:
```tsx
import { useState } from 'react';
import type { TabNode } from '../../model/types';
import { faviconUrl } from '../chrome/favicon';

interface Props {
  tab: TabNode;
  selected: boolean;
  onSelect: (e: React.MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
}

export function TabRow({ tab, selected, onSelect, onActivate }: Props) {
  const [iconFailed, setIconFailed] = useState(false);
  const cls = ['row', 'tab', tab.active && 'active', tab.discarded && 'discarded'].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      data-key={tab.key}
      data-kind="tab"
      aria-selected={selected}
      title={tab.url}
      onClick={(e) => onSelect(e, tab.key)}
      onDoubleClick={() => onActivate(tab)}
    >
      {tab.url && !iconFailed ? (
        <img className="favicon" src={faviconUrl(tab.url)} alt="" onError={() => setIconFailed(true)} />
      ) : (
        <span className="favicon placeholder" />
      )}
      <span className="title">{tab.title}</span>
    </div>
  );
}
```

`src/view/components/GroupRow.tsx`:
```tsx
import type { GroupNode, TabNode } from '../../model/types';
import { TabRow } from './TabRow';

interface Props {
  group: GroupNode;
  collapsed: boolean;
  selected: ReadonlySet<string>;
  onToggleCollapse: (key: string) => void;
  onSelect: (e: React.MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
}

export function GroupRow({ group, collapsed, selected, onToggleCollapse, onSelect, onActivate }: Props) {
  const style = { '--group-color': `var(--group-${group.color})` } as React.CSSProperties;
  return (
    <div style={style}>
      <div
        className="row group-header"
        data-key={group.key}
        data-kind="group"
        aria-selected={selected.has(group.key)}
        onClick={(e) => onSelect(e, group.key)}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(group.key);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="group-dot" />
        <span className="title">{group.title}</span>
        <span className="count">{group.tabs.length}</span>
      </div>
      {!collapsed && (
        <div className="group-tabs">
          {group.tabs.map((t) => (
            <TabRow key={t.key} tab={t} selected={selected.has(t.key)} onSelect={onSelect} onActivate={onActivate} />
          ))}
        </div>
      )}
    </div>
  );
}
```

`src/view/components/WindowCard.tsx`:
```tsx
import type { TabNode, WindowNode } from '../../model/types';
import { isGroupCollapsed, type CollapseState } from '../../model/visibleRows';
import { GroupRow } from './GroupRow';
import { TabRow } from './TabRow';

interface Props {
  win: WindowNode;
  collapse: CollapseState;
  selected: ReadonlySet<string>;
  onToggleWindow: (key: string) => void;
  onToggleGroup: (key: string) => void;
  onSelect: (e: React.MouseEvent, key: string) => void;
  onActivate: (tab: TabNode) => void;
  onFocusWindow: (windowId: number) => void;
}

export function WindowCard(p: Props) {
  const { win } = p;
  const collapsed = p.collapse.collapsedWindows.has(win.key);
  return (
    <section data-testid="window-card" className={win.focused ? 'card focused' : 'card'}>
      <div
        className="row window-header"
        data-key={win.key}
        data-kind="window"
        aria-selected={p.selected.has(win.key)}
        onClick={(e) => p.onSelect(e, win.key)}
        onDoubleClick={() => p.onFocusWindow(win.windowId)}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleWindow(win.key);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="title">{win.label}</span>
        <span className="count">
          {win.tabCount} tabs{win.focused ? ' · focused' : ''}
        </span>
      </div>
      {!collapsed &&
        win.children.map((c) =>
          c.kind === 'group' ? (
            <GroupRow
              key={c.key}
              group={c}
              collapsed={isGroupCollapsed(c, p.collapse)}
              selected={p.selected}
              onToggleCollapse={p.onToggleGroup}
              onSelect={p.onSelect}
              onActivate={p.onActivate}
            />
          ) : (
            <TabRow key={c.key} tab={c} selected={p.selected.has(c.key)} onSelect={p.onSelect} onActivate={p.onActivate} />
          ),
        )}
    </section>
  );
}
```

- [ ] **Step 5: App wiring**

`src/view/App.tsx`:
```tsx
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { buildTree } from '../model/buildTree';
import { emptySelection, selectionReducer } from '../model/selection';
import type { RawSnapshot, TabNode } from '../model/types';
import { allRowKeys, isGroupCollapsed, visibleRowKeys, type CollapseState } from '../model/visibleRows';
import { activateTab, focusWindow, snapshot, subscribe } from './chrome/chromeSource';
import { selectionActionFor } from './components/rowClick';
import { WindowCard } from './components/WindowCard';

export function App() {
  const [snap, setSnap] = useState<RawSnapshot | null>(null);
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [collapse, setCollapse] = useState<CollapseState>({
    collapsedWindows: new Set(),
    groupOverrides: new Map(),
  });

  const refresh = useCallback(() => {
    void snapshot().then(setSnap);
  }, []);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  const tree = useMemo(() => (snap ? buildTree(snap) : []), [snap]);
  const visible = useMemo(() => visibleRowKeys(tree, collapse), [tree, collapse]);

  useEffect(() => {
    dispatch({ type: 'prune', existing: allRowKeys(tree) });
  }, [tree]);

  const onSelect = (e: React.MouseEvent, key: string) => dispatch(selectionActionFor(e, key, visible));
  const onActivate = (t: TabNode) => void activateTab(t.tabId, t.windowId).catch(refresh);
  const onFocusWindow = (id: number) => void focusWindow(id).catch(refresh);

  const onToggleWindow = (key: string) =>
    setCollapse((c) => {
      const next = new Set(c.collapsedWindows);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...c, collapsedWindows: next };
    });

  const onToggleGroup = (key: string) =>
    setCollapse((c) => {
      const group = tree.flatMap((w) => w.children).find((x) => x.key === key);
      if (!group || group.kind !== 'group') return c;
      const next = new Map(c.groupOverrides);
      next.set(key, !isGroupCollapsed(group, c));
      return { ...c, groupOverrides: next };
    });

  return (
    <main>
      {tree.map((w) => (
        <WindowCard
          key={w.key}
          win={w}
          collapse={collapse}
          selected={selection.selected}
          onToggleWindow={onToggleWindow}
          onToggleGroup={onToggleGroup}
          onSelect={onSelect}
          onActivate={onActivate}
          onFocusWindow={onFocusWindow}
        />
      ))}
    </main>
  );
}
```

Add `import './styles/theme.css';` to the top of `src/view/main.tsx`.

- [ ] **Step 6: Verify**

Run: `npm run format && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all pass. If `chrome.tabs.Tab` / `chrome.tabGroups` typings in `@types/chrome` differ (for example `discarded` being optional), coerce with `?? false` in `chromeSource.ts` rather than loosening the model types.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Render live window cards with group rows, selection, and double-click activate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end suite, gate, and docs

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/tree.spec.ts`
- Modify: `CLAUDE.md` (add the gates table and the testing notes), `README.md` (how to load unpacked)

**Interfaces:**
- Consumes: the DOM contract from Task 4, `VIEW_PATH` and `globalThis.tabHammer.openOrFocus` from Task 1.

- [ ] **Step 1: Playwright config and fixture**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  retries: 0,
});
```

`tests/e2e/fixtures.ts`:
```ts
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '../../dist');
export const VIEW_PATH = 'src/view/index.html';

type Fixtures = { context: BrowserContext; sw: Worker; extensionId: string; view: Page };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    // channel 'chromium' = full Chromium in new headless mode, which supports extensions
    // (the default headless shell does not).
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  view: async ({ context, sw }, use) => {
    // Open the view exactly as the toolbar click does, then attach to that page.
    const pagePromise = context.waitForEvent('page', (p) => p.url().includes(VIEW_PATH));
    await sw.evaluate(() =>
      (globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }).tabHammer.openOrFocus(),
    );
    const view = await pagePromise;
    await view.waitForLoadState();
    await use(view);
  },
});

export { expect } from '@playwright/test';
```

- [ ] **Step 2: Write the E2E tests**

`tests/e2e/tree.spec.ts`:
```ts
import { expect, test, VIEW_PATH } from './fixtures';

type Setup = { winA: number; winB: number; groupedTabIds: number[]; lonelyTabId: number };

// Build a known layout from inside the extension's service worker (it has the tabs/tabGroups APIs).
async function buildLayout(sw: import('@playwright/test').Worker): Promise<Setup> {
  return sw.evaluate(async () => {
    const a = await chrome.windows.create({ url: ['data:text/html,<title>Alpha</title>', 'data:text/html,<title>Bravo</title>', 'data:text/html,<title>Charlie</title>'] });
    const b = await chrome.windows.create({ url: 'data:text/html,<title>Delta</title>' });
    const aTabs = await chrome.tabs.query({ windowId: a!.id });
    const grouped = aTabs.slice(0, 2).map((t) => t.id!);
    const groupId = await chrome.tabs.group({ tabIds: grouped, createProperties: { windowId: a!.id } });
    await chrome.tabGroups.update(groupId, { title: 'Research', color: 'red' });
    const bTabs = await chrome.tabs.query({ windowId: b!.id });
    return { winA: a!.id!, winB: b!.id!, groupedTabIds: grouped, lonelyTabId: bTabs[0]!.id! };
  });
}

test('opening twice focuses the existing Tab Hammer window instead of making another', async ({ context, sw, view }) => {
  await sw.evaluate(() =>
    (globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }).tabHammer.openOrFocus(),
  );
  const viewPages = context.pages().filter((p) => p.url().includes(VIEW_PATH));
  expect(viewPages).toHaveLength(1);
  expect(viewPages[0]).toBe(view);
});

test('renders window cards with a group row and indented tabs, excluding itself', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const cardA = view.locator('section[data-testid="window-card"]', { has: view.locator(`[data-key="w:${s.winA}"]`) });
  await expect(cardA.locator('[data-kind="group"] .title')).toHaveText('Research');
  await expect(cardA.locator('.group-tabs [data-kind="tab"] .title')).toHaveText(['Alpha', 'Bravo']);
  await expect(cardA.locator(':scope > [data-kind="tab"] .title')).toHaveText(['Charlie']);
  await expect(view.locator(`[data-key="t:${s.lonelyTabId}"] .title`)).toHaveText('Delta');

  const selfId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await expect(view.locator(`[data-key="w:${selfId}"]`)).toHaveCount(0);
});

test('reflects a closed tab live', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const row = view.locator(`[data-key="t:${s.lonelyTabId}"]`);
  await expect(row).toBeVisible();
  await sw.evaluate(async (id) => {
    await chrome.tabs.create({ url: 'data:text/html,<title>Echo</title>' }); // keep window B alive
    await chrome.tabs.remove(id);
  }, s.lonelyTabId);
  await expect(row).toHaveCount(0);
});

test('click selects one, cmd/ctrl-click toggles, shift-click selects a range', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const [t1, t2] = s.groupedTabIds;
  const row = (k: string) => view.locator(`[data-key="${k}"]`);
  await row(`t:${t1}`).click();
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'true');
  await row(`t:${s.lonelyTabId}`).click({ modifiers: ['ControlOrMeta'] });
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'true');
  await expect(row(`t:${s.lonelyTabId}`)).toHaveAttribute('aria-selected', 'true');
  await row(`t:${t2}`).click();
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'false');
  await row(`w:${s.winA}`).click({ modifiers: ['Shift'] });
  // anchor is t2; visible rows from w:A down to t2 are: window header, group row, t1, t2
  await expect(view.locator('[aria-selected="true"]')).toHaveCount(4);
});

test('double-click a tab activates it and focuses its window', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const [t1] = s.groupedTabIds;
  await view.locator(`[data-key="t:${t1}"]`).dblclick();
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, t1))
    .toBe(true);
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.windows.getLastFocused()).id))
    .toBe(s.winA);
});
```

- [ ] **Step 3: Build and run E2E**

Run: `npm run build && npm run test:e2e`
Expected: 5 passed.

If a test fails, diagnose it; don't weaken it. Specifically:

- **Focus assertions under headless.** If the double-click test's `getLastFocused` assertion fails, first confirm whether `windows.update({focused:true})` has any effect in new-headless Chromium. Log `chrome.windows.getAll()` focused flags after the call.
  - If headless genuinely cannot change focus, set `headless: false` for this suite only and note in CLAUDE.md that the e2e gate opens a browser window.
  - Do not delete the focus assertion. Focusing the window is half of the feature.
- **Chrome rejects `data:` URLs.** If it rejects them in `windows.create`, serve tiny pages from an in-test `http.createServer` on port 0 instead.
- **The view page is served from a different path.** If the dist layout changed, update `VIEW_PATH` in both files.

- [ ] **Step 4: Run the full gate**

Run: `npm run gate`
Expected: typecheck, lint, format check, unit tests (18), build, and e2e (5) all pass.

- [ ] **Step 5: Document gates and local loading**

Append to `CLAUDE.md`:
```markdown
## Completion gates

Pick the gate by change class. Report the gate name and result when declaring work complete.

| Gate | Command | When |
|---|---|---|
| Docs-only diff | (none) | Every changed path is `.md`. |
| Any code change | `npm run gate` | typecheck + lint + format check + unit (Vitest) + build + e2e (Playwright, real Chromium with the built extension). |

Run it once on the final commit. The e2e suite launches its own throwaway Chromium profile; it never touches the user's Chrome.

## Architecture in one breath

A service worker only opens or focuses the Tab Hammer popup window. The view page reads Chrome's live windows, tabs, and groups (`src/view/chrome/chromeSource.ts`, the only view module that touches `chrome.*`). It feeds them through two pure, unit-tested modules: `src/model/buildTree.ts` (raw data → window/group/tab view model) and `src/model/selection.ts` (multi-select reducer). Then it renders React components. Chrome window and tab IDs are not stable across restarts, so persistence (post-MVP) must introduce Tab Hammer's own node IDs.

## Tests

- Unit: `src/model/__tests__/`. Pure logic only.
- E2E: `tests/e2e/`. The fixture opens the view through the service worker's `tabHammer.openOrFocus` test hook, the same code path as the toolbar click.
```

Append to `README.md`:
```markdown
## Develop

    npm install
    npm run build          # outputs dist/
    npm run gate           # all checks

Load it in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`. Click the toolbar icon to open Tab Hammer.
```

- [ ] **Step 6: Commit**

```bash
npm run format
git add -A
git commit -m "Add Playwright e2e suite against the real extension and the gate command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After all tasks

- Push `dave/mvp-tree-view` and open a PR against `main` titled "Tab Hammer MVP: live tree view". The body summarizes what shipped and any deviations from this plan, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Do not merge. The user smoke-tests by loading `dist/` unpacked.

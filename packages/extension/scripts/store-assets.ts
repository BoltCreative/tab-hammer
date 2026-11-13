// Renders the Chrome Web Store images (docs/store/images/) from the built extension, in headless
// Chromium with a throwaway profile:
//   npm run store-assets -w @tab-hammer/extension
// That command builds dist-e2e first (`npm run build:e2e`), then runs this script, which loads the
// extension from dist-e2e (never ~/.tab-hammer/dist). It's tooling, not a test, and not part of
// `npm run gate`. See docs/store/listing.md for what each image shows.
//
// It builds a made-up outline (open-source project pages, docs, and news front pages, every one a
// local fake page served through `context.route`: no real site is contacted), captures the Tab
// Hammer view at each step, and composes each store image as an HTML page in a second headless
// Chromium: the view's screenshot on a backdrop, beside a drawn browser window showing a fake page.
// Headless Chromium can't screenshot its own browser UI, hence the drawing.
//
// Every wait is on a state that's certain to arrive (a tab loaded, an outline record, a row
// rendered, a preview saved); `expect`'s timeout below is only a hang guard.
import {
  chromium,
  expect as baseExpect,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { TestHooks } from '../src/background/index.ts';
import type { GroupColor } from '../src/model/types.ts';
import type { WindowRec } from '../src/model/outline/types.ts';
import { windowColor } from '../src/model/windowColor.ts';
import { createFakeDrive } from '../tests/fakeDrive.ts';
import {
  launchWithExtension,
  liveRow,
  outlineCommand,
  readOutline,
  runMenuAction,
  serviceWorkerOf,
} from '../tests/e2e/fixtures.ts';

const expect = baseExpect.configure({ timeout: 120_000 });

const OUT = path.resolve(import.meta.dirname, '../../../docs/store/images');
const ICONS = path.resolve(import.meta.dirname, '../icons');
const VIEW_PATH = 'src/view/index.html';
const VIEW = { width: 420, height: 720 };

// ---------------------------------------------------------------------------------------------
// The made-up outline.

type Kind = 'repo' | 'docs' | 'news' | 'wiki' | 'home';

interface Site {
  name: string;
  bar: string; // header bar background
  ink: string; // header bar text
  accent: string;
  bg: string; // page background
  text: string;
}

const LIGHT = { bg: '#ffffff', text: '#1f2328' };
const SITES: Record<string, Site> = {
  'github.com': { name: 'GitHub', bar: '#24292f', ink: '#fff', accent: '#2f81f7', ...LIGHT },
  'developer.mozilla.org': {
    name: 'MDN Web Docs',
    bar: '#1b1b1b',
    ink: '#fff',
    accent: '#0085f2',
    ...LIGHT,
  },
  'developer.chrome.com': {
    name: 'Chrome for Developers',
    bar: '#f1f3f4',
    ink: '#202124',
    accent: '#1a73e8',
    ...LIGHT,
  },
  'www.typescriptlang.org': {
    name: 'TypeScript',
    bar: '#3178c6',
    ink: '#fff',
    accent: '#3178c6',
    ...LIGHT,
  },
  'doc.rust-lang.org': {
    name: 'The Rust Programming Language',
    bar: '#f5f1e8',
    ink: '#3b2e2a',
    accent: '#b7410e',
    bg: '#fffdf8',
    text: '#2b2522',
  },
  'crates.io': { name: 'crates.io', bar: '#3b6837', ink: '#fff', accent: '#3b6837', ...LIGHT },
  'news.ycombinator.com': {
    name: 'Hacker News',
    bar: '#ff6600',
    ink: '#000',
    accent: '#ff6600',
    bg: '#f6f6ef',
    text: '#222',
  },
  'lwn.net': { name: 'LWN.net', bar: '#ffcc00', ink: '#000', accent: '#996600', ...LIGHT },
  'arstechnica.com': {
    name: 'Ars Technica',
    bar: '#121212',
    ink: '#fff',
    accent: '#ff4e00',
    bg: '#1c1c1c',
    text: '#e8e8e8',
  },
  'en.wikipedia.org': {
    name: 'Wikipedia',
    bar: '#f8f9fa',
    ink: '#202122',
    accent: '#3366cc',
    ...LIGHT,
  },
  'jellyfin.org': { name: 'Jellyfin', bar: '#101010', ink: '#fff', accent: '#aa5cc3', ...LIGHT },
  'caddyserver.com': {
    name: 'Caddy',
    bar: '#ffffff',
    ink: '#1f2328',
    accent: '#1f88c0',
    ...LIGHT,
  },
  'wiki.archlinux.org': {
    name: 'ArchWiki',
    bar: '#333333',
    ink: '#fff',
    accent: '#1793d1',
    ...LIGHT,
  },
};

interface FakeTab {
  url: string;
  title: string;
  kind: Kind;
  heading: string;
  blurb: string;
  group?: number; // index into its window's groups
}
interface FakeWindow {
  name: string;
  groups: { title: string; color: GroupColor }[];
  tabs: FakeTab[];
}

const WINDOWS: FakeWindow[] = [
  {
    name: 'Web platform',
    groups: [{ title: 'Docs', color: 'blue' }],
    tabs: [
      {
        url: 'https://github.com/vitejs/vite',
        title: 'GitHub - vitejs/vite: Next generation frontend tooling',
        kind: 'repo',
        heading: 'vitejs / vite',
        blurb: 'Next generation frontend tooling. It’s fast!',
      },
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
        title: 'Array.prototype.map() - JavaScript | MDN',
        kind: 'docs',
        heading: 'Array.prototype.map()',
        blurb:
          'The map() method of Array instances creates a new array populated with the results of calling a provided function on every element in the calling array.',
        group: 0,
      },
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
        title: 'Using the Fetch API - Web APIs | MDN',
        kind: 'docs',
        heading: 'Using the Fetch API',
        blurb:
          'The Fetch API provides a JavaScript interface for making HTTP requests and processing the responses.',
        group: 0,
      },
      {
        url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups',
        title: 'chrome.tabGroups | API | Chrome for Developers',
        kind: 'docs',
        heading: 'chrome.tabGroups',
        blurb:
          'Use the chrome.tabGroups API to interact with the browser’s tab grouping system. You can modify and rearrange tab groups.',
        group: 0,
      },
      {
        url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
        title: 'TypeScript: Handbook - The TypeScript Handbook',
        kind: 'docs',
        heading: 'The TypeScript Handbook',
        blurb:
          'Over 20 years after its introduction to the programming community, JavaScript is now one of the most widespread cross-platform languages ever created.',
      },
    ],
  },
  {
    name: 'Learning Rust',
    groups: [{ title: 'The Book', color: 'orange' }],
    tabs: [
      {
        url: 'https://doc.rust-lang.org/book/',
        title: 'The Rust Programming Language',
        kind: 'docs',
        heading: 'The Rust Programming Language',
        blurb:
          'This version of the text assumes you are using Rust 1.85.0 or later, with edition = "2024" in the Cargo.toml file of all projects.',
        group: 0,
      },
      {
        url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
        title: 'What is Ownership? - The Rust Programming Language',
        kind: 'docs',
        heading: 'What is Ownership?',
        blurb:
          'Ownership is a set of rules that govern how a Rust program manages memory. All programs have to manage the way they use a computer’s memory while running.',
        group: 0,
      },
      {
        url: 'https://doc.rust-lang.org/rust-by-example/',
        title: 'Introduction - Rust By Example',
        kind: 'docs',
        heading: 'Rust by Example',
        blurb:
          'Rust by Example is a collection of runnable examples that illustrate various Rust concepts and standard libraries.',
        group: 0,
      },
      {
        url: 'https://crates.io/crates/serde',
        title: 'serde - crates.io: Rust Package Registry',
        kind: 'home',
        heading: 'serde',
        blurb: 'A generic serialization/deserialization framework',
      },
      {
        url: 'https://github.com/tokio-rs/tokio',
        title: 'GitHub - tokio-rs/tokio: A runtime for writing reliable asynchronous applications',
        kind: 'repo',
        heading: 'tokio-rs / tokio',
        blurb:
          'A runtime for writing reliable asynchronous applications with Rust. Provides I/O, networking, scheduling, timers, …',
      },
    ],
  },
  {
    name: 'Morning news',
    groups: [],
    tabs: [
      {
        url: 'https://news.ycombinator.com/',
        title: 'Hacker News',
        kind: 'news',
        heading: 'Hacker News',
        blurb: '',
      },
      {
        url: 'https://lwn.net/',
        title: 'Welcome to LWN.net',
        kind: 'news',
        heading: 'LWN.net',
        blurb: '',
      },
      {
        url: 'https://arstechnica.com/',
        title: 'Ars Technica',
        kind: 'news',
        heading: 'Ars Technica',
        blurb: '',
      },
      {
        url: 'https://en.wikipedia.org/wiki/Main_Page',
        title: 'Wikipedia, the free encyclopedia',
        kind: 'wiki',
        heading: 'Welcome to Wikipedia',
        blurb: 'the free encyclopedia that anyone can edit.',
      },
    ],
  },
  {
    name: 'Home server',
    groups: [],
    tabs: [
      {
        url: 'https://github.com/home-assistant/core',
        title: 'GitHub - home-assistant/core: Open source home automation',
        kind: 'repo',
        heading: 'home-assistant / core',
        blurb: 'Open source home automation that puts local control and privacy first.',
      },
      {
        url: 'https://jellyfin.org/docs/general/quick-start/',
        title: 'Quick Start | Jellyfin',
        kind: 'docs',
        heading: 'Quick Start',
        blurb:
          'Jellyfin is the volunteer-built media solution that puts you in control of your media.',
      },
      {
        url: 'https://caddyserver.com/docs/caddyfile/concepts',
        title: 'Caddyfile Concepts - Caddy Documentation',
        kind: 'docs',
        heading: 'Caddyfile Concepts',
        blurb:
          'This document will help you learn about the HTTP Caddyfile in detail: its structure, addresses, matchers and directives.',
      },
      {
        url: 'https://wiki.archlinux.org/title/Systemd',
        title: 'systemd - ArchWiki',
        kind: 'wiki',
        heading: 'systemd',
        blurb:
          'systemd is a suite of basic building blocks for a Linux system. It provides a system and service manager.',
      },
    ],
  },
];

// Made for screenshot 3, then closed: it waits in Recently closed.
const CLOSED_WINDOW: FakeWindow = {
  name: 'Weekend reading',
  groups: [],
  tabs: [
    {
      url: 'https://en.wikipedia.org/wiki/Typography',
      title: 'Typography - Wikipedia',
      kind: 'wiki',
      heading: 'Typography',
      blurb:
        'Typography is the art and technique of arranging type to make written language legible, readable and appealing when displayed.',
    },
    {
      url: 'https://en.wikipedia.org/wiki/Lighthouse',
      title: 'Lighthouse - Wikipedia',
      kind: 'wiki',
      heading: 'Lighthouse',
      blurb:
        'A lighthouse is a tower, building, or other type of physical structure designed to emit light from a system of lamps and lenses.',
    },
    {
      url: 'https://en.wikipedia.org/wiki/Sourdough',
      title: 'Sourdough - Wikipedia',
      kind: 'wiki',
      heading: 'Sourdough',
      blurb:
        'Sourdough is a type of bread that uses the fermentation by naturally occurring yeast and lactobacillus bacteria to raise the dough.',
    },
  ],
};

const ALL_TABS = [...WINDOWS, CLOSED_WINDOW].flatMap((w) => w.tabs);
const pageKey = (url: string) => url.split('#')[0]!;
const TABS_BY_URL = new Map(ALL_TABS.map((t) => [pageKey(t.url), t]));

// ---------------------------------------------------------------------------------------------
// Fake pages: a header bar, a title, and text blocks, per kind, so the previews look like pages.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FILLER = [
  'It is designed to be fast to start, simple to configure, and easy to extend as a project grows.',
  'The examples below cover the common cases first, then the options most projects never need.',
  'Each section builds on the one before it, so reading in order is the quickest way through.',
  'Contributions are welcome: see the contributing guide for how to set up a development build.',
  'The reference lists every option with its default value and the version it first appeared in.',
  'Community chat, discussions and the issue tracker are linked from the sidebar of every page.',
];

const HEADLINES = [
  'A small static site generator written in Zig',
  'The surprisingly long history of the floppy disk',
  'Notes on writing a garbage collector in a weekend',
  'Ask: what’s your favourite command-line tool?',
  'Why we moved our build to a single binary',
  'An interactive guide to how GPS works',
  'Kernel release status: the merge window is open',
  'A visual introduction to hash maps',
  'The design of a tiny text editor',
  'Exploring the open hardware keyboard scene',
  'Lessons from ten years of running a mailing list',
  'How browsers lay out text, from bytes to pixels',
];

function favicon(site: Site): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${site.accent}"/><text x="16" y="23" font-family="Arial,sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#fff">${esc(site.name[0]!)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const lines = (n: number, color: string, widths = [100, 96, 98, 84]) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<div class="line" style="width:${widths[i % widths.length]}%;background:${color}"></div>`,
  ).join('');

function body(t: FakeTab, site: Site): string {
  const soft = site.bg === '#1c1c1c' ? '#3a3a3a' : '#e7e9ec';
  switch (t.kind) {
    case 'repo':
      return `<main class="narrow">
        <div class="crumb"><b>${esc(t.heading)}</b> <span class="pill">Public</span></div>
        <div class="tabsrow"><span class="on">Code</span><span>Issues</span><span>Pull requests</span><span>Discussions</span><span>Actions</span></div>
        <div class="cols"><div>
          <div class="files">${[
            '.github',
            'docs',
            'packages',
            'scripts',
            'CHANGELOG.md',
            'LICENSE',
            'README.md',
            'package.json',
          ]
            .map(
              (f, i) =>
                `<div class="file"><span class="fname">${f}</span><span class="fmsg" style="width:${30 + ((i * 17) % 35)}%"></span><span class="fage">${2 + i} days ago</span></div>`,
            )
            .join('')}</div>
          <div class="readme"><h2>${esc(t.heading.split(' / ')[1] ?? t.heading)}</h2><p>${esc(t.blurb)}</p><p>${FILLER[0]} ${FILLER[3]}</p>${lines(3, soft)}</div>
        </div><aside><h4>About</h4><p>${esc(t.blurb)}</p>${lines(4, soft, [70, 55, 62, 48])}</aside></div>
      </main>`;
    case 'docs':
      return `<div class="docs"><nav>${[
        'Getting started',
        'Installation',
        'Guide',
        'Concepts',
        'Reference',
        'Examples',
        'Configuration',
        'Troubleshooting',
        'FAQ',
        'Changelog',
      ]
        .map((n, i) => `<div class="${i === 2 ? 'on' : ''}">${n}</div>`)
        .join('')}</nav><main>
        <div class="crumb2">Docs › Guide</div>
        <h1>${esc(t.heading)}</h1><p class="lead">${esc(t.blurb)}</p><p>${FILLER[1]} ${FILLER[2]}</p>
        <pre><span class="k">const</span> result = <span class="f">run</span>(input, { verbose: <span class="k">true</span> });
<span class="k">for</span> (<span class="k">const</span> item <span class="k">of</span> result.items) {
  console.<span class="f">log</span>(item.name);
}</pre>
        <h3>Syntax</h3><p>${FILLER[4]}</p>${lines(4, soft)}<h3>Examples</h3>${lines(3, soft)}
      </main></div>`;
    case 'news':
      return `<main class="news">${HEADLINES.map(
        (h, i) =>
          `<div class="story"><span class="rank">${i + 1}.</span><div><div class="hl">${esc(h)}</div><div class="meta">${120 - i * 7} points · ${3 + i} hours ago · ${40 + ((i * 13) % 90)} comments</div></div></div>`,
      ).join('')}</main>`;
    case 'wiki':
      return `<main class="wiki"><h1>${esc(t.heading)}</h1><div class="from">From ${esc(site.name)}</div>
        <div class="infobox"><div class="img"></div>${lines(5, soft, [90, 70, 80, 60])}</div>
        <p><b>${esc(t.heading)}</b> ${esc(t.blurb.replace(/^\S+ /, ''))}</p><p>${FILLER[2]} ${FILLER[5]}</p>
        <h2>History</h2>${lines(5, soft)}<h2>Overview</h2>${lines(4, soft)}</main>`;
    case 'home':
      return `<section class="hero"><h1>${esc(t.heading)}</h1><p>${esc(t.blurb)}</p><div class="search"></div></section>
        <main class="narrow cards">${[
          'Readme',
          'Versions',
          'Dependencies',
          'Dependents',
          'Install',
          'Documentation',
        ]
          .map((c) => `<div class="card"><h4>${c}</h4>${lines(3, soft, [90, 70, 80])}</div>`)
          .join('')}</main>`;
  }
}

function fakePage(t: FakeTab): string {
  const site = SITES[new URL(t.url).host]!;
  const soft = site.bg === '#1c1c1c' ? '#2a2a2a' : '#f3f4f6';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<link rel="icon" href="${favicon(site)}">
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,system-ui,'Segoe UI',sans-serif;background:${site.bg};color:${site.text}}
header{height:60px;background:${site.bar};color:${site.ink};display:flex;align-items:center;gap:18px;padding:0 28px;border-bottom:1px solid rgba(0,0,0,.08)}
.logo{width:30px;height:30px;border-radius:8px;background:${site.bar === site.accent ? '#fff' : site.accent};color:${site.bar === site.accent ? site.accent : '#fff'};display:grid;place-items:center;font-weight:700}
.sname{font-weight:650;font-size:17px}.nav{display:flex;gap:16px;opacity:.75;font-size:14px}.sbox{margin-left:auto;width:240px;height:32px;border-radius:8px;background:rgba(127,127,127,.18)}
.line{height:11px;border-radius:6px;margin:10px 0}
main.narrow{max-width:1040px;margin:0 auto;padding:24px 28px}
.crumb{font-size:21px;color:${site.accent}}.crumb b{font-weight:600}.pill{font-size:12px;border:1px solid #d0d7de;border-radius:20px;padding:1px 8px;color:#59636e;vertical-align:middle}
.tabsrow{display:flex;gap:22px;margin:16px 0 20px;border-bottom:1px solid #d0d7de;font-size:14px}.tabsrow span{padding:8px 0}.tabsrow .on{border-bottom:2px solid #fd8c73;font-weight:600}
.cols{display:grid;grid-template-columns:1fr 260px;gap:28px}aside h4{margin:4px 0 6px}aside p{margin:0 0 8px;font-size:14px}
.files{border:1px solid #d0d7de;border-radius:8px;overflow:hidden}.file{display:flex;gap:16px;align-items:center;padding:9px 14px;border-top:1px solid #eaeef2;font-size:14px}.file:first-child{border-top:0;background:#f6f8fa}
.fname{width:150px;color:${site.text}}.fmsg{height:10px;border-radius:5px;background:#e7e9ec}.fage{margin-left:auto;white-space:nowrap;color:#59636e;font-size:13px}
.readme{border:1px solid #d0d7de;border-radius:8px;margin-top:18px;padding:6px 22px 16px}.readme h2{border-bottom:1px solid #eaeef2;padding-bottom:6px}
.docs{display:grid;grid-template-columns:230px 1fr;min-height:calc(100vh - 60px)}
.docs nav{background:${soft};padding:22px 18px;font-size:14px}.docs nav div{padding:6px 10px;border-radius:6px}.docs nav .on{background:${site.accent}1f;color:${site.accent};font-weight:600}
.docs main{padding:22px 40px;max-width:860px}.crumb2{font-size:13px;opacity:.6}h1{font-size:34px;line-height:1.2;margin:8px 0 12px}.lead{font-size:17px}
pre{background:#1e1f24;color:#d4d6da;border-radius:8px;padding:16px 18px;font:13.5px/1.6 ui-monospace,Menlo,monospace}.k{color:#c58af9}.f{color:#78d9ec}
.news{max-width:1040px;margin:0 auto;padding:14px 28px}.story{display:flex;gap:10px;padding:7px 0}.rank{color:#828282;width:26px;text-align:right}.hl{font-size:15px}.meta{font-size:12px;color:#828282}
.wiki{max-width:1040px;margin:0 auto;padding:20px 32px}.wiki h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;border-bottom:1px solid #a2a9b1;padding-bottom:4px}.from{font-size:13px;color:#54595d;margin-bottom:12px}.wiki h2{font-family:Georgia,serif;font-weight:400;border-bottom:1px solid #c8ccd1}
.infobox{float:right;width:250px;margin:0 0 12px 20px;border:1px solid #a2a9b1;background:#f8f9fa;padding:10px}.infobox .img{height:150px;background:linear-gradient(135deg,#c8d6e5,#8395a7);border-radius:2px}
.hero{background:${site.accent};color:#fff;text-align:center;padding:42px 20px 50px}.hero h1{margin:0 0 6px}.hero .search{margin:20px auto 0;width:min(520px,80%);height:40px;border-radius:8px;background:#fff}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{border:1px solid #e1e4e8;border-radius:10px;padding:6px 16px 10px}
</style></head><body>
<header><div class="logo">${esc(site.name[0]!)}</div><div class="sname">${esc(site.name)}</div><div class="nav"><span>Docs</span><span>Blog</span><span>Community</span></div><div class="sbox"></div></header>
${body(t, site)}
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Driving the extension.

const hooks = (sw: Worker) => ({
  hasPreview: (url: string) =>
    sw.evaluate(
      (u) => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.hasPreview(u),
      url,
    ),
  focusWindow: (id: number) =>
    sw.evaluate(
      (i) => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.focusWindow(i),
      id,
    ),
  useTestSync: (apiBase: string, token: string) =>
    sw.evaluate(
      (o) => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.useTestSync(o),
      { apiBase, token },
    ),
  syncNow: () =>
    sw.evaluate(() => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.syncNow()),
  syncState: () =>
    sw.evaluate(() => (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.syncState()),
});

interface Built {
  spec: FakeWindow;
  chromeWindowId: number;
  tabIds: number[];
  rec: WindowRec;
}

/**
 * Opens a fake window's tabs (in `windowId`, else a new window), groups and names it, and waits
 * until its outline record holds every tab, loaded. A tab's requests are routed only once
 * Playwright has attached to it, so each tab starts on a placeholder and navigates once Playwright
 * has seen it (as preview.spec.ts's openBackgroundTabs does).
 */
async function openWindow(
  context: BrowserContext,
  sw: Worker,
  spec: FakeWindow,
  key: string,
  windowId?: number,
): Promise<Built> {
  const placeholders = spec.tabs.map((_, i) => `about:blank#${key}-${i}`);
  const opened = await sw.evaluate(
    async ({ placeholders, windowId }) => {
      let id = windowId;
      const tabIds: number[] = [];
      let rest = placeholders;
      if (id === undefined) {
        const win = await chrome.windows.create({ url: placeholders[0] });
        id = win!.id!;
        tabIds.push(win!.tabs![0]!.id!);
        rest = placeholders.slice(1);
      }
      for (const url of rest)
        tabIds.push((await chrome.tabs.create({ windowId: id, url, active: false })).id!);
      return { id, tabIds };
    },
    { placeholders, windowId },
  );
  await expect
    .poll(() => context.pages().map((p) => p.url()))
    .toEqual(expect.arrayContaining(placeholders));
  await sw.evaluate(
    async ({ ids, urls, groups, windowId }) => {
      await Promise.all(ids.map((id, i) => chrome.tabs.update(id, { url: urls[i] })));
      for (const g of groups) {
        const groupId = await chrome.tabs.group({
          tabIds: g.tabs.map((i) => ids[i]!) as [number, ...number[]],
          createProperties: { windowId },
        });
        await chrome.tabGroups.update(groupId, { title: g.title, color: g.color });
      }
    },
    {
      ids: opened.tabIds,
      urls: spec.tabs.map((t) => t.url),
      windowId: opened.id,
      groups: spec.groups.map((g, gi) => ({
        ...g,
        tabs: spec.tabs.flatMap((t, i) => (t.group === gi ? [i] : [])),
      })),
    },
  );
  const titles = spec.tabs.map((t) => t.title);
  await expect
    .poll(() =>
      sw.evaluate(
        async (ids) =>
          Promise.all(
            ids.map(async (id) => {
              const t = await chrome.tabs.get(id);
              return t.status === 'complete' ? t.title : null;
            }),
          ),
        opened.tabIds,
      ),
    )
    .toEqual(titles);
  const find = async () =>
    (await readOutline(sw)).windows.find(
      (w) => w.state === 'live' && w.chromeWindowId === opened.id,
    );
  await expect
    .poll(async () => (await find())?.tabs.map((t) => t.title))
    .toEqual(expect.arrayContaining(titles));
  const rec = (await find())!;
  await outlineCommand(sw, { cmd: 'rename', windowId: rec.id, name: spec.name });
  return { spec, chromeWindowId: opened.id, tabIds: opened.tabIds, rec };
}

/** Waits until the view shows these live tabs (by Chrome ID) and nothing else. */
async function viewShows(view: Page, tabIds: number[]) {
  await expect
    .poll(() =>
      view.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-tab-id]')].map((r) =>
          Number(r.dataset.tabId),
        ),
      ),
    )
    .toEqual(tabIds);
}

/** Hovers a tab row and waits for the preview panel to show its screenshot. */
async function hoverForPreview(view: Page, row: Locator, url: string) {
  await row.hover();
  const panel = view.getByTestId('preview-panel');
  await expect(panel).toContainText(url);
  await expect(panel.locator('.preview-shot')).toHaveJSProperty('complete', true);
  const box = (await row.boundingBox())!;
  return { x: Math.round(box.x + box.width * 0.42), y: Math.round(box.y + box.height * 0.6) };
}

async function setPanel(sw: Worker, view: Page, settings: { expanded: boolean; height: number }) {
  await sw.evaluate((s) => chrome.storage.local.set({ previewPanel: s }), settings);
  await view.reload();
}

// ---------------------------------------------------------------------------------------------
// Composing the store images.

const iconSvg = await readFile(path.join(ICONS, 'icon.svg'), 'utf8');
const ICON_URL = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;
const png = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:#e8e9ec;
  background:radial-gradient(1200px 700px at 85% 10%,rgba(76,95,213,.38),transparent 60%),
    radial-gradient(900px 600px at 0% 100%,rgba(46,58,156,.45),transparent 65%),#17181b;position:relative}
.abs{position:absolute}
.brand{display:flex;align-items:center;gap:12px}
.brand img{width:40px;height:40px}
.brand span{font-size:19px;font-weight:650;letter-spacing:.2px;color:#fff}
h1{margin:0;font-size:38px;line-height:1.12;font-weight:700;letter-spacing:-.4px;color:#fff}
.sub{margin-top:12px;font-size:17px;line-height:1.45;color:#b4b8c2}
.view{border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
.view img{display:block}
.browser{border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}
.tabstrip{height:38px;background:#1f2023;display:flex;align-items:flex-end;padding:0 10px;gap:2px}
.dots{display:flex;gap:7px;margin:0 14px 13px 4px}.dots i{width:11px;height:11px;border-radius:50%;background:#4a4c52}
.btab{height:30px;width:170px;border-radius:9px 9px 0 0;display:flex;align-items:center;gap:7px;padding:0 10px;font-size:11.5px;color:#9aa0a6;white-space:nowrap;overflow:hidden}
.btab.on{background:#35363a;color:#e8eaed}.btab img{width:14px;height:14px;flex:none;border-radius:3px}.btab span{overflow:hidden;text-overflow:ellipsis}
.omni{height:38px;background:#35363a;display:flex;align-items:center;gap:12px;padding:0 12px;color:#9aa0a6;font-size:13px}
.omni .arrows{letter-spacing:10px}.omni .bar{flex:1;height:26px;border-radius:13px;background:#202124;display:flex;align-items:center;padding:0 14px;color:#bdc1c6;overflow:hidden;white-space:nowrap}
.page{position:relative;overflow:hidden;background:#fff}
.page iframe{border:0;transform-origin:0 0;position:absolute;left:0;top:0}
.cursor{position:absolute;width:22px;height:30px}
`;

const CURSOR_SVG = `<svg viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 24 L7.5 18.8 L11.4 27.6 L15 26 L11.2 17.4 L18.6 17.4 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function browserFrame(
  win: FakeWindow,
  activeIndex: number,
  box: { x: number; y: number; w: number; h: number },
): string {
  const active = win.tabs[activeIndex]!;
  const start = Math.max(0, activeIndex - 3); // four tabs fit, the active one among them
  const tabs = win.tabs
    .slice(start, start + 4)
    .map(
      (t, i) =>
        `<div class="btab${i + start === activeIndex ? ' on' : ''}"><img src="${favicon(SITES[new URL(t.url).host]!)}"><span>${esc(t.title)}</span></div>`,
    )
    .join('');
  const pageH = box.h - 76;
  const scale = 0.68;
  return `<div class="abs browser" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px">
    <div class="tabstrip"><div class="dots"><i></i><i></i><i></i></div>${tabs}</div>
    <div class="omni"><span class="arrows">←→↻</span><div class="bar">${esc(active.url.replace(/^https:\/\//, ''))}</div></div>
    <div class="page" style="height:${pageH}px"><iframe srcdoc="${esc(fakePage(active))}" style="width:${Math.ceil(box.w / scale)}px;height:${Math.ceil(pageH / scale)}px;transform:scale(${scale})"></iframe></div>
  </div>`;
}

interface Shot {
  headline: string;
  sub: string;
  view: Buffer;
  frame: { win: FakeWindow; active: number };
  cursor?: { x: number; y: number }; // in the view's coordinates
}

/** A 1280×800 screenshot: caption and browser window on the left, the Tab Hammer view on the right. */
function screenshotHtml(s: Shot): string {
  const vx = 820,
    vy = 40;
  return `<style>${BASE_CSS}</style>
  <div class="abs brand" style="left:56px;top:48px"><img src="${ICON_URL}"><span>Tab Hammer</span></div>
  <div class="abs" style="left:56px;top:112px;width:720px"><h1>${esc(s.headline)}</h1><div class="sub">${esc(s.sub)}</div></div>
  ${browserFrame(s.frame.win, s.frame.active, { x: 56, y: 262, w: 724, h: 498 })}
  <div class="abs view" style="left:${vx}px;top:${vy}px"><img src="${png(s.view)}" width="${VIEW.width}" height="${VIEW.height}"></div>
  ${s.cursor ? `<div class="cursor" style="left:${vx + s.cursor.x}px;top:${vy + s.cursor.y}px">${CURSOR_SVG}</div>` : ''}`;
}

/** Screenshot 4's layout: the caption on the left, two views side by side. */
function twoViewsHtml(headline: string, sub: string, a: Buffer, b: Buffer): string {
  return `<style>${BASE_CSS}</style>
  <div class="abs brand" style="left:56px;top:48px"><img src="${ICON_URL}"><span>Tab Hammer</span></div>
  <div class="abs" style="left:56px;top:300px;width:300px"><h1>${esc(headline)}</h1><div class="sub">${esc(sub)}</div></div>
  <div class="abs view" style="left:380px;top:40px"><img src="${png(a)}" width="${VIEW.width}" height="${VIEW.height}"></div>
  <div class="abs view" style="left:830px;top:40px"><img src="${png(b)}" width="${VIEW.width}" height="${VIEW.height}"></div>`;
}

/** Stylised window bars in the outline's colours, for the promo tiles. */
function miniOutline(colors: string[], width: number, rowsPer = [3, 2, 3, 2]): string {
  return colors
    .map(
      (c, i) => `<div style="margin-bottom:9px">
        <div style="height:16px;border-radius:5px;background:#25272c;border-left:4px solid ${c};display:flex;align-items:center;padding-left:8px"><div style="height:5px;width:${38 + ((i * 23) % 30)}%;border-radius:3px;background:${c};opacity:.9"></div></div>
        ${Array.from(
          { length: rowsPer[i % rowsPer.length]! },
          (_, j) =>
            `<div style="height:5px;margin:6px 0 0 16px;border-radius:3px;background:#4a4d55;width:${width * (0.45 + ((i + j * 3) % 4) * 0.1)}px"></div>`,
        ).join('')}
      </div>`,
    )
    .join('');
}

function smallTileHtml(colors: string[]): string {
  return `<style>${BASE_CSS}
    body{background:radial-gradient(420px 300px at 0% 0%,rgba(76,95,213,.35),transparent 70%),#17181b}</style>
  <div class="abs" style="left:34px;top:0;height:280px;display:flex;flex-direction:column;justify-content:center;gap:16px">
    <img src="${ICON_URL}" style="width:104px;height:104px">
    <div style="font-size:34px;font-weight:700;letter-spacing:-.3px;color:#fff">Tab Hammer</div>
  </div>
  <div class="abs" style="left:262px;top:48px;width:150px">${miniOutline(colors, 120)}</div>`;
}

function marqueeHtml(view: Buffer, viewSize: { width: number; height: number }): string {
  return `<style>${BASE_CSS}</style>
  <div class="abs" style="left:110px;top:0;height:560px;display:flex;flex-direction:column;justify-content:center">
    <div style="display:flex;align-items:center;gap:22px"><img src="${ICON_URL}" style="width:112px;height:112px">
    <div style="font-size:60px;font-weight:700;letter-spacing:-.8px;color:#fff">Tab Hammer</div></div>
    <div style="margin-top:26px;font-size:28px;color:#b4b8c2">Every tab, one outline</div>
  </div>
  <div class="abs view" style="left:${1400 - 120 - viewSize.width}px;top:${(560 - viewSize.height) / 2}px"><img src="${png(view)}" width="${viewSize.width}" height="${viewSize.height}"></div>`;
}

async function render(
  page: Page,
  html: string,
  size: { width: number; height: number },
  file: string,
) {
  await page.setViewportSize(size);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`wrote ${path.relative(process.cwd(), path.join(OUT, file))}`);
}

// ---------------------------------------------------------------------------------------------
// The run.

await mkdir(OUT, { recursive: true });

// A fake Drive for screenshot 4's other computer, on 127.0.0.1 (never Google).
const TOKEN = 'store-assets-token';
const drive = createFakeDrive({ tokens: [TOKEN] });
const driveServer = http.createServer((req, res) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (data += chunk));
  req.on('end', () => {
    const r = drive.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | undefined>,
      body: data,
    });
    res.writeHead(r.status, r.contentType ? { 'content-type': r.contentType } : {});
    res.end(r.body);
  });
});
await new Promise<void>((resolve) => driveServer.listen(0, '127.0.0.1', resolve));
const driveBase = `http://127.0.0.1:${(driveServer.address() as AddressInfo).port}`;

const context = await launchWithExtension();
const composer = await chromium.launch({ channel: 'chromium' });
try {
  // Every web request but the fake Drive's gets a fake page: nothing reaches a real site.
  await context.route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1',
    (route) => {
      const tab = TABS_BY_URL.get(pageKey(route.request().url()));
      return tab
        ? route.fulfill({ contentType: 'text/html', body: fakePage(tab) })
        : route.fulfill({ status: 404, body: '' });
    },
  );
  const sw = await serviceWorkerOf(context);
  const h = hooks(sw);

  // The profile's first window becomes the first fake window; its blank tab goes once it's filled.
  const first = await sw.evaluate(async () => {
    const [w] = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    return { windowId: w!.id!, tabId: w!.tabs![0]!.id! };
  });
  const built: Built[] = [];
  built.push(await openWindow(context, sw, WINDOWS[0]!, 'w0', first.windowId));
  await sw.evaluate((id) => chrome.tabs.remove(id), first.tabId);
  await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), built[0]!.tabIds[0]!);
  // Window colours come from Tab Hammer's random window IDs; reopen a window until its colour is
  // one no earlier window has, so every section bar differs.
  for (let i = 1; i < WINDOWS.length; i++) {
    for (let attempt = 0; ; attempt++) {
      const b = await openWindow(context, sw, WINDOWS[i]!, `w${i}-${attempt}`);
      if (!built.some((x) => windowColor(x.rec.id) === windowColor(b.rec.id))) {
        built.push(b);
        break;
      }
      await outlineCommand(sw, { cmd: 'trash', ids: [b.rec.id] });
      await outlineCommand(sw, { cmd: 'deleteForever', windowId: b.rec.id });
    }
  }
  // Tab Hammer's window order is its own; put the windows in the order above.
  for (let i = 1; i < built.length; i++)
    await outlineCommand(sw, {
      cmd: 'moveWindows',
      ids: [built[i]!.rec.id],
      anchorId: built[i - 1]!.rec.id,
      side: 'after',
    });
  await h.focusWindow(built[0]!.chromeWindowId);
  const allTabIds = built.flatMap((b) => b.tabIds);

  // The view, opened as the toolbar click does.
  const viewPromise = context.waitForEvent('page', (p) => p.url().includes(VIEW_PATH));
  await sw.evaluate(() =>
    (globalThis as unknown as { tabHammer: TestHooks }).tabHammer.openOrFocus(),
  );
  const view = await viewPromise;
  await view.waitForLoadState();
  // No fade-ins: a screenshot never catches a preview halfway in.
  await view.emulateMedia({ reducedMotion: 'reduce' });
  await view.setViewportSize(VIEW);
  await viewShows(view, allTabIds);

  // Previews for every tab: the Actions menu's Capture missing, then a reload to clear its status.
  // A tab can be skipped (Chrome's own capture of a visible tab racing the run); run it again for
  // what's still missing, a few times at most.
  const missing = async () => {
    const out: string[] = [];
    for (const t of WINDOWS.flatMap((w) => w.tabs))
      if (!(await h.hasPreview(t.url))) out.push(t.url);
    return out;
  };
  for (let run = 0; (await missing()).length > 0; run++) {
    if (run === 3) throw new Error(`no preview for ${(await missing()).join(', ')}`);
    await runMenuAction(view, 'Capture missing');
    await expect(view.getByRole('status')).toHaveText(/^refreshed /);
    await view.reload();
    await viewShows(view, allTabIds);
  }

  // The window colours, for the promo tiles.
  const colors = await view.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-window-id]')].map((h) =>
      getComputedStyle(h.closest<HTMLElement>('[style*="--window-color"]') ?? h)
        .getPropertyValue('--window-color')
        .trim(),
    ),
  );

  const composePage = await composer.newPage();
  const SHOT = { width: 1280, height: 800 };

  // 1. The outline, a tab hovered.
  const mdn = WINDOWS[0]!.tabs[2]!;
  let cursor = await hoverForPreview(view, liveRow(view, 'tab', built[0]!.tabIds[2]!), mdn.url);
  await render(
    composePage,
    screenshotHtml({
      headline: 'Every tab, one outline',
      sub: 'All your windows, tab groups and tabs in one list. Name windows, drag tabs between them, and jump to any tab.',
      view: await view.screenshot(),
      frame: { win: WINDOWS[0]!, active: 0 },
      cursor,
    }),
    SHOT,
    'screenshot-1-outline.png',
  );

  // Marquee: the top of the same view, nothing hovered. The viewport stays one size all run (a
  // resized one can be screenshot before it repaints).
  const MARQUEE_VIEW = { width: VIEW.width, height: 480 };
  await view.mouse.move(0, 0);
  const marqueeView = await view.screenshot({ clip: { x: 0, y: 0, ...MARQUEE_VIEW } });

  // 2. Previews: a taller panel, the cursor resting on a tab in another window.
  await setPanel(sw, view, { expanded: true, height: 380 });
  await viewShows(view, allTabIds);
  const book = WINDOWS[1]!.tabs[1]!;
  cursor = await hoverForPreview(view, liveRow(view, 'tab', built[1]!.tabIds[1]!), book.url);
  await render(
    composePage,
    screenshotHtml({
      headline: 'See a tab before you switch',
      sub: 'Rest the pointer on a tab, or move to it with the arrow keys, to see how the page looked when you last had it open.',
      view: await view.screenshot(),
      frame: { win: WINDOWS[2]!, active: 0 },
      cursor,
    }),
    SHOT,
    'screenshot-2-previews.png',
  );

  // 5. Search: typing filters every window to the matches.
  await setPanel(sw, view, { expanded: true, height: 260 });
  await viewShows(view, allTabIds);
  const query = 'github';
  const matches = built.flatMap((b) =>
    b.tabIds.filter((_, i) =>
      `${b.spec.tabs[i]!.title} ${b.spec.tabs[i]!.url}`.toLowerCase().includes(query),
    ),
  );
  await view.getByRole('combobox').fill(query);
  await viewShows(view, matches);
  await view.keyboard.press('ArrowDown');
  const firstMatch = ALL_TABS.find((t) => t.url.includes(query))!;
  await expect(view.getByTestId('preview-panel')).toContainText(firstMatch.url);
  await expect(view.locator('.preview-shot')).toHaveJSProperty('complete', true);
  await render(
    composePage,
    screenshotHtml({
      headline: 'Find any tab as you type',
      sub: 'Search titles and addresses across every window, then press Enter to go there.',
      view: await view.screenshot(),
      frame: { win: WINDOWS[1]!, active: 3 },
    }),
    SHOT,
    'screenshot-5-search.png',
  );
  await view.getByRole('combobox').fill('');
  await view.keyboard.press('Escape');
  await viewShows(view, allTabIds);

  // 3. Hibernate and restore: one window hibernated, another closed and waiting in Recently closed.
  const home = built[3]!;
  await outlineCommand(sw, { cmd: 'hibernate', ids: [home.rec.id] });
  const closed = await openWindow(context, sw, CLOSED_WINDOW, 'closed');
  await outlineCommand(sw, { cmd: 'trash', ids: [closed.rec.id] });
  await expect
    .poll(async () =>
      (await readOutline(sw)).windows
        .filter((w) => w.id === home.rec.id || w.id === closed.rec.id)
        .map((w) => [w.id, w.state]),
    )
    .toEqual([
      [home.rec.id, 'hibernated'],
      [closed.rec.id, 'trashed'],
    ]);
  await view.reload();
  await viewShows(
    view,
    built.slice(0, 3).flatMap((b) => b.tabIds),
  );
  // Fold the first two windows so the hibernated one and Recently closed fit.
  for (const b of built.slice(0, 2))
    await liveRow(view, 'window', b.chromeWindowId).locator('.twisty').click();
  await view.getByRole('button', { name: /^Recently closed/ }).click();
  await view.getByTestId('trash-entry').getByRole('button', { name: 'Expand' }).click();
  await expect(view.getByText(CLOSED_WINDOW.tabs.at(-1)!.title)).toBeVisible();
  const sleeping = view
    .locator(`[data-key="w:${home.rec.id}"]`)
    .locator('xpath=..')
    .getByText(WINDOWS[3]!.tabs[2]!.title);
  cursor = await hoverForPreview(view, sleeping, WINDOWS[3]!.tabs[2]!.url);
  await render(
    composePage,
    screenshotHtml({
      headline: 'Put windows away, bring them back',
      sub: 'Hibernate a window to close it in Chrome and keep its tabs, dimmed, to reopen with a click. Closed windows wait in Recently closed for seven days.',
      view: await view.screenshot(),
      frame: { win: WINDOWS[0]!, active: 1 },
      cursor,
    }),
    SHOT,
    'screenshot-3-hibernate.png',
  );

  // 4. Other devices: another Tab Hammer computer through (fake) Drive, and a phone through
  // Chrome Sync, whose chrome.sessions is stood in for here.
  const now = Date.now();
  const remoteId = 'studio-desktop';
  const remoteTab = (id: string, url: string, title: string, groupId?: string) => ({
    id,
    url,
    title,
    modifiedAt: now,
    ...(groupId && { groupId }),
  });
  const remoteWin = (id: string, name: string, tabs: unknown[], groups: unknown[] = []) => ({
    id,
    name,
    state: 'live',
    lastLiveAt: now,
    originInstallId: remoteId,
    modifiedAt: now,
    tabs,
    groups,
  });
  drive.put(
    `outline-${remoteId}.json`,
    JSON.stringify({
      schemaVersion: 1,
      installId: remoteId,
      computerName: 'Studio desktop',
      platform: 'linux',
      updatedAt: now - 4 * 60_000,
      windows: [
        remoteWin(
          'r1',
          'Release prep',
          [
            remoteTab('r1a', 'https://github.com/vitejs/vite/releases', 'Releases · vitejs/vite'),
            remoteTab(
              'r1b',
              'https://github.com/vitejs/vite/milestones',
              'Milestones · vitejs/vite',
              'rg1',
            ),
            remoteTab(
              'r1c',
              'https://github.com/vitejs/vite/pulls',
              'Pull requests · vitejs/vite',
              'rg1',
            ),
            remoteTab(
              'r1d',
              'https://semver.org/',
              'Semantic Versioning 2.0.0 | Semantic Versioning',
            ),
          ],
          [{ id: 'rg1', title: 'Review', color: 'purple', collapsed: false, modifiedAt: now }],
        ),
        remoteWin('r2', 'Conference talks', [
          remoteTab('r2a', 'https://www.youtube.com/@FOSDEM', 'FOSDEM - YouTube'),
          remoteTab('r2b', 'https://fosdem.org/2026/schedule/', 'FOSDEM 2026 - Schedule'),
          remoteTab('r2c', 'https://www.usenix.org/conferences', 'Conferences | USENIX'),
        ]),
        remoteWin('r3', 'Typography', [
          remoteTab('r3a', 'https://fonts.google.com/', 'Browse Fonts - Google Fonts'),
          remoteTab('r3b', 'https://practicaltypography.com/', 'Butterick’s Practical Typography'),
          remoteTab('r3c', 'https://en.wikipedia.org/wiki/Kerning', 'Kerning - Wikipedia'),
        ]),
      ],
    }),
  );
  await sw.evaluate(
    (t) => {
      const nowSec = Math.floor(Date.now() / 1000);
      (chrome as unknown as { sessions: unknown }).sessions = {
        getDevices: async () => [
          {
            deviceName: 'Phone',
            sessions: [
              {
                lastModified: nowSec - 20 * 60,
                window: {
                  sessionId: 'p1',
                  tabs: t.map(([url, title], i) => ({ sessionId: `p1-${i}`, url, title })),
                },
              },
            ],
          },
        ],
        restore: async () => {
          throw new Error('not on this run');
        },
      };
    },
    [
      ['https://news.ycombinator.com/', 'Hacker News'],
      ['https://en.wikipedia.org/wiki/Lighthouse', 'Lighthouse - Wikipedia'],
      ['https://www.openstreetmap.org/', 'OpenStreetMap'],
    ],
  );
  await h.useTestSync(driveBase, TOKEN);
  await h.syncNow();
  await expect.poll(async () => (await h.syncState()).computers.length).toBe(1);
  // The preview panel folded: neither view here has a tab to preview.
  await setPanel(sw, view, { expanded: false, height: 260 });
  await viewShows(
    view,
    built.slice(0, 3).flatMap((b) => b.tabIds),
  );
  // The view asks Chrome whether the optional sessions permission is granted; here it is.
  await view.evaluate(() => {
    const p = chrome.permissions;
    const contains = p.contains.bind(p);
    p.contains = ((q: chrome.permissions.Permissions) =>
      q.permissions?.includes('sessions')
        ? Promise.resolve(true)
        : contains(q)) as typeof p.contains;
  });
  await runMenuAction(view, 'Other devices…');
  await expect(view.getByTestId('picker-computer')).toContainText('Studio desktop');
  await expect(view.getByTestId('picker-device')).toContainText('Phone');
  await view.mouse.move(0, 0);
  const devicesShot = await view.screenshot();
  await view.getByTestId('picker-computer').click();
  await expect(view.getByTestId('remote-banner')).toBeVisible();
  await expect(view.getByTestId('remote-tab')).toHaveCount(10);
  await view.mouse.move(0, 0);
  const remoteShot = await view.screenshot();
  await render(
    composePage,
    twoViewsHtml(
      'Your other devices’ tabs',
      'See what’s open on your other computers and your phone, read-only, and open any of it here.',
      devicesShot,
      remoteShot,
    ),
    SHOT,
    'screenshot-4-devices.png',
  );

  // Promo tiles.
  await render(
    composePage,
    smallTileHtml(colors),
    { width: 440, height: 280 },
    'promo-small-440x280.png',
  );
  await render(
    composePage,
    marqueeHtml(marqueeView, MARQUEE_VIEW),
    { width: 1400, height: 560 },
    'promo-marquee-1400x560.png',
  );
} finally {
  await composer.close();
  await context.close();
  await new Promise<void>((resolve) => {
    driveServer.close(() => resolve());
    driveServer.closeAllConnections();
  });
}

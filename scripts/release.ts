// Bumps Tab Hammer's version everywhere it's written: the extension manifest (what Chrome and the
// Chrome Web Store read), every workspace's package.json, package-lock.json, and the MCP registry
// listing (packages/mcp/server.json). Commits nothing; it prints the next steps
// (docs/store/release.md).
//
//   npm run release -- patch|minor|major|<x.y.z>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const MANIFEST = 'packages/extension/src/manifest.ts';
const WORKSPACES = ['packages/protocol', 'packages/extension', 'packages/mcp'];
const PACKAGE_JSONS = ['package.json', ...WORKSPACES.map((w) => `${w}/package.json`)];
// The manifest's own line, `const RELEASE = '1.2.3';`, matched exactly once.
const MANIFEST_VERSION = /^(const RELEASE = ')(\d+\.\d+\.\d+)(';)$/m;

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

type Version = [number, number, number];
const parse = (v: string): Version | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as Version;
  // Chrome allows each part 0 to 65535, without leading zeros.
  return parts.every((n, i) => n <= 65535 && String(n) === m[i + 1]) ? parts : null;
};
const greater = (a: Version, b: Version) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

const arg = process.argv[2];
if (!arg) fail('usage: npm run release -- patch|minor|major|<x.y.z>');

const read = (file: string) => readFile(path.join(root, file), 'utf8');
const write = (file: string, text: string) => writeFile(path.join(root, file), text);

const manifestText = await read(MANIFEST);
const matches = manifestText.match(new RegExp(MANIFEST_VERSION.source, 'gm')) ?? [];
if (matches.length !== 1) fail(`expected one version line in ${MANIFEST}, found ${matches.length}`);
const current = MANIFEST_VERSION.exec(manifestText)![2]!;
const cur = parse(current) ?? fail(`${MANIFEST} has an unusable version ${current}`);

const pkgs = await Promise.all(
  PACKAGE_JSONS.map(async (file) => ({
    file,
    json: JSON.parse(await read(file)) as { version?: string },
  })),
);
const drifted = pkgs.filter((p) => p.json.version !== current);
if (drifted.length > 0)
  fail(
    `versions disagree with the manifest's ${current}: ` +
      drifted.map((p) => `${p.file} ${p.json.version}`).join(', '),
  );

const next: Version =
  arg === 'major'
    ? [cur[0] + 1, 0, 0]
    : arg === 'minor'
      ? [cur[0], cur[1] + 1, 0]
      : arg === 'patch'
        ? [cur[0], cur[1], cur[2] + 1]
        : (parse(arg) ?? fail(`"${arg}" is not patch, minor, major, or a version like 1.2.3`));
if (!greater(next, cur)) fail(`${next.join('.')} is not above the current ${current}`);
const version = next.join('.');

await write(MANIFEST, manifestText.replace(MANIFEST_VERSION, `$1${version}$3`));
for (const p of pkgs) await write(p.file, JSON.stringify({ ...p.json, version }, null, 2) + '\n');

// package-lock.json records the same versions: the root, and each workspace's entry.
const lock = JSON.parse(await read('package-lock.json')) as {
  version: string;
  packages: Record<string, { version?: string }>;
};
lock.version = version;
for (const key of ['', ...WORKSPACES]) {
  const entry = lock.packages[key] ?? fail(`package-lock.json has no "${key}" entry`);
  entry.version = version;
}
await write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

// The MCP registry listing names the npm package at the same version, twice.
const SERVER_JSON = 'packages/mcp/server.json';
const listing = JSON.parse(await read(SERVER_JSON)) as {
  version: string;
  packages: { version?: string }[];
};
listing.version = version;
for (const pkg of listing.packages) pkg.version = version;
await write(SERVER_JSON, JSON.stringify(listing, null, 2) + '\n');

console.log(`Tab Hammer ${current} -> ${version}
Changed: ${[MANIFEST, ...PACKAGE_JSONS, 'package-lock.json', SERVER_JSON].join(', ')}

Next (docs/store/release.md):
  npm run gate
  git commit -am "chore: release ${version}"
  Land it through a PR. Merging uploads ${version}.<build> to the store as a draft, and the
  Release workflow (Actions -> Release) submits it for review.`);

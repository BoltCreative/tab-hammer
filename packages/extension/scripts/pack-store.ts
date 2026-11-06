// Zips the Chrome Web Store build (dist-store/, from `npm run build:store`) into
// release/tab-hammer-<version>.zip, the file to upload. Refuses a build the store would reject or
// that would sign in with the dev OAuth client. Plain Node (zlib), so it runs the same everywhere.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { GOOGLE_OAUTH_CLIENT_ID } from '../src/shared/syncConfig.ts';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist-store');
const releaseDir = path.join(root, 'release');

function fail(message: string): never {
  console.error(`pack-store: ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8')) as {
  version?: string;
  key?: unknown;
  oauth2?: { client_id?: string };
};
if ('key' in manifest) fail('manifest.json has a "key"; the Chrome Web Store rejects it.');
if (manifest.oauth2?.client_id === GOOGLE_OAUTH_CLIENT_ID)
  fail('manifest.json uses the dev OAuth client, which only works for the dev extension ID.');
if (!manifest.version) fail('manifest.json has no version.');

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile() && entry.name !== '.DS_Store') out.push(full);
  }
  return out;
}

// A fixed timestamp (1980-01-01, the zip epoch) keeps the zip byte-identical for the same build.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;

const locals: Buffer[] = [];
const centrals: Buffer[] = [];
let offset = 0;
const files = (await listFiles(distDir)).sort();
for (const file of files) {
  const name = Buffer.from(path.relative(distDir, file).split(path.sep).join('/'), 'utf8');
  const data = await readFile(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed: 2.0
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(DEFLATE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // extra length
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(UTF8_FLAG, 8);
  central.writeUInt16LE(DEFLATE, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // extra, comment, disk number, internal and external attributes: all 0
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

await mkdir(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, `tab-hammer-${manifest.version}.zip`);
await writeFile(zipPath, Buffer.concat([...locals, ...centrals, end]));
console.log(
  `pack-store: ${path.relative(process.cwd(), zipPath)} (${files.length} files)` +
    (manifest.oauth2 ? '' : ', Drive sync off (no store OAuth client ID yet)'),
);

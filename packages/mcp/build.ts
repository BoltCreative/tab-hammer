// Builds the publishable package into dist/ (plain JavaScript, one file per entry point):
//   cli.js     the `tab-hammer-mcp` command: install / uninstall / doctor, or serve
//   server.js  the MCP server, with its npm dependencies bundled in
//   host.js    the native messaging host, which must not depend on any npm package
// Every file is self-contained, so the installer can copy server.js and host.js out to a folder
// with no node_modules, and the published package has no runtime dependencies.
import { builtinModules } from 'node:module';
import path from 'node:path';
import { rolldown, type Plugin } from 'rolldown';

const ROOT = import.meta.dirname;
const OUT = path.join(ROOT, 'dist');
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** The host runs from a bare folder: refuse any npm import except our own (inlined) protocol. */
const hostImportsOnlyBuiltins: Plugin = {
  name: 'host-imports-only-builtins',
  resolveId(source, importer) {
    if (source.startsWith('.') || path.isAbsolute(source) || builtins.has(source)) return null;
    if (source === '@tab-hammer/protocol') return null;
    throw new Error(`host.ts must not import npm packages: ${source} (from ${importer})`);
  },
};

const entries = [
  { name: 'cli', input: 'src/cli.ts', banner: '#!/usr/bin/env node', plugins: [] },
  { name: 'server', input: 'src/main.ts', banner: '', plugins: [] },
  { name: 'host', input: 'src/host.ts', banner: '', plugins: [hostImportsOnlyBuiltins] },
];

export async function buildPackage(outDir = OUT): Promise<void> {
  for (const e of entries) {
    const bundle = await rolldown({
      input: path.join(ROOT, e.input),
      platform: 'node',
      external: (id) => builtins.has(id),
      plugins: e.plugins,
      // jsonc-parser's default (UMD) entry hides its requires from the bundler; its ESM one doesn't.
      resolve: { mainFields: ['module', 'main'] },
      logLevel: 'warn',
    });
    await bundle.write({
      file: path.join(outDir, `${e.name}.js`),
      format: 'esm',
      banner: e.banner,
      codeSplitting: false,
    });
    await bundle.close();
  }
}

// `node build.ts [outDir]`: the dev server's MCP autodeploy builds into a temp folder.
if (import.meta.main) await buildPackage(process.argv[2] ? path.resolve(process.argv[2]) : OUT);

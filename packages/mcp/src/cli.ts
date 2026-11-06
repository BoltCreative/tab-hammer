// `npx tab-hammer-mcp [install | uninstall | doctor | serve]`. With no command it runs the MCP
// server over stdio (dist/server.js), which is how MCP registries and clients launch an npm server.
import { formatChecks, doctor } from './install/doctor.ts';
import { realEnv } from './install/env.ts';
import { HELP, parseArgs } from './cliArgs.ts';
import { install, layout, manualInstructions, uninstall } from './install/installer.ts';
import { HARNESSES } from './install/harnesses.ts';

async function main(): Promise<number> {
  const { command, opts, help } = parseArgs(process.argv.slice(2));
  if (help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === 'serve') {
    // The bundled server next to this file starts serving when loaded. A URL keeps the bundler
    // from inlining it, so install/doctor don't load the MCP SDK.
    const server = new URL('./server.js', import.meta.url).href;
    await import(server);
    return -1; // keep running
  }
  const env = realEnv();
  const log = (s: string) => console.log(s);
  if (command === 'install') {
    const report = install(env, { ...opts, log });
    const missed = HARNESSES.filter((h) => report.skipped.includes(h.id)).map((h) => h.name);
    if (missed.length) console.log(`\nNot found: ${missed.join(', ')}.`);
    console.log('\n' + manualInstructions(env));
    console.log(
      '\nNext: reload Tab Hammer in your browser (or click its toolbar icon) so it connects, then ' +
        'restart your agent. Check it with `npx tab-hammer-mcp doctor`.',
    );
    return report.failed.length ? 1 : 0;
  }
  if (command === 'uninstall') {
    const report = uninstall(env, { ...opts, log });
    return report.failed.length ? 1 : 0;
  }
  if (command === 'doctor') {
    const checks = await doctor(env, opts);
    console.log(`Tab Hammer MCP (${layout(env).dir})\n`);
    console.log(formatChecks(checks));
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  throw new Error(`Unknown command ${command}. Run with --help.`);
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

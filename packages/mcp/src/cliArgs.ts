// Command-line parsing for cli.ts, kept apart so tests can import it without running the CLI.
import { ALL_IDS, type Options } from './install/installer.ts';

export const HELP = `Usage: npx tab-hammer-mcp <command> [options]

Commands:
  install     Deploy the native host, register it with every browser found, and register the
              MCP server with every agent harness found. Safe to re-run.
  uninstall   Undo exactly what install did.
  doctor      Check the host registrations, the extension connection, and harness configs.
  serve       Run the MCP server over stdio (the default with no command).

Options:
  --only <ids>          Only these targets (comma-separated).
  --skip <ids>          Everything except these.
  --extension-id <id>   Also allow this extension ID (repeatable), e.g. a store build's.

Targets: ${ALL_IDS.join(', ')}
`;

export function parseArgs(argv: string[]): { command: string; opts: Options; help: boolean } {
  const opts: Options = {};
  let command = '';
  let help = false;
  const list = (v: string | undefined, flag: string) => {
    if (!v) throw new Error(`${flag} needs a value`);
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] =
      a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--only') opts.only = [...(opts.only ?? []), ...list(value(), flag)];
    else if (flag === '--skip') opts.skip = [...(opts.skip ?? []), ...list(value(), flag)];
    else if (flag === '--extension-id') {
      const id = value();
      if (!id || !/^[a-p]{32}$/.test(id))
        throw new Error(`--extension-id needs a 32-letter extension ID`);
      opts.extensionIds = [...(opts.extensionIds ?? []), id];
    } else if (flag === '--help' || flag === '-h') help = true;
    else if (!flag!.startsWith('-') && !command) command = flag!;
    else throw new Error(`Unknown argument ${a}`);
  }
  return { command: command || 'serve', opts, help };
}

// The agent harnesses the installer registers the MCP server with, each in its own config format.
// Formats checked against each vendor's docs in November 2026:
//   Claude Code     `claude mcp add -s user` (stored in ~/.claude.json)  code.claude.com/docs/en/mcp
//   Claude Desktop  claude_desktop_config.json, "mcpServers"            modelcontextprotocol.io/docs/develop/connect-local-servers
//   Codex           $CODEX_HOME/config.toml, [mcp_servers.<name>]        learn.chatgpt.com/docs/extend/mcp
//   Cursor          ~/.cursor/mcp.json, "mcpServers", type "stdio"       cursor.com/docs/context/mcp
//   VS Code         <user profile>/mcp.json, "servers", type "stdio"     code.visualstudio.com/docs/copilot/reference/mcp-configuration
//   Windsurf        ~/.codeium/windsurf/mcp_config.json, "mcpServers"    docs.devin.ai/desktop/cascade/mcp
//   Devin Desktop   ~/.config/devin/mcp_config.json, "mcpServers"        (Windsurf's new name since June 2026)
import type { InstallEnv } from './env.ts';
import { isDir } from './env.ts';

export const SERVER_NAME = 'tab-hammer';

export interface ServerCommand {
  command: string;
  args: string[];
}

interface Base {
  id: string;
  name: string;
  /** Whether it looks installed (a folder it keeps its settings in, or its CLI on PATH). */
  detect(env: InstallEnv): boolean;
  /** Where the user would find it, for messages. */
  where(env: InstallEnv): string;
}

/** A JSON file with the server under `container`. */
export interface JsonHarness extends Base {
  kind: 'json';
  file(env: InstallEnv): string;
  container: string;
  entry(cmd: ServerCommand): Record<string, unknown>;
}

/** A TOML file with the server as a `[table]`. */
export interface TomlHarness extends Base {
  kind: 'toml';
  file(env: InstallEnv): string;
  table: string;
}

/** Registered through the harness's own CLI. */
export interface CliHarness extends Base {
  kind: 'cli';
  command: string;
  addArgs(cmd: ServerCommand): string[];
  removeArgs: string[];
  getArgs: string[];
}

export type Harness = JsonHarness | TomlHarness | CliHarness;

const plain = (c: ServerCommand) => ({ command: c.command, args: c.args });
const stdio = (c: ServerCommand) => ({ type: 'stdio', command: c.command, args: c.args });

/** A per-user app settings folder: Application Support, %APPDATA%, or ~/.config. */
function appSupport(env: InstallEnv, name: string): string {
  const p = env.path;
  if (env.os === 'darwin') return p.join(env.home, 'Library', 'Application Support', name);
  if (env.os === 'win32') return p.join(env.appData, name);
  return p.join(env.xdgConfig, name);
}

function jsonHarness(
  id: string,
  name: string,
  dir: (env: InstallEnv) => string,
  fileName: string,
  container: string,
  entry: JsonHarness['entry'],
): JsonHarness {
  return {
    id,
    name,
    kind: 'json',
    container,
    entry,
    file: (env) => env.path.join(dir(env), fileName),
    detect: (env) => isDir(dir(env)),
    where: (env) => env.path.join(dir(env), fileName),
  };
}

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'cli',
    command: 'claude',
    detect: (env) => env.runner.has('claude'),
    where: () => '`claude mcp` (user scope)',
    addArgs: (c) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', c.command, ...c.args],
    removeArgs: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
    getArgs: ['mcp', 'get', SERVER_NAME],
  },
  jsonHarness(
    'claude-desktop',
    'Claude Desktop',
    (env) => appSupport(env, 'Claude'),
    'claude_desktop_config.json',
    'mcpServers',
    plain,
  ),
  {
    id: 'codex',
    name: 'Codex',
    kind: 'toml',
    table: `mcp_servers.${SERVER_NAME}`,
    file: (env) => env.path.join(env.codexHome, 'config.toml'),
    detect: (env) => isDir(env.codexHome),
    where: (env) => env.path.join(env.codexHome, 'config.toml'),
  },
  jsonHarness(
    'cursor',
    'Cursor',
    (env) => env.path.join(env.home, '.cursor'),
    'mcp.json',
    'mcpServers',
    stdio,
  ),
  jsonHarness(
    'vscode',
    'VS Code',
    (env) => env.path.join(appSupport(env, 'Code'), 'User'),
    'mcp.json',
    'servers',
    stdio,
  ),
  jsonHarness(
    'vscode-insiders',
    'VS Code Insiders',
    (env) => env.path.join(appSupport(env, 'Code - Insiders'), 'User'),
    'mcp.json',
    'servers',
    stdio,
  ),
  jsonHarness(
    'windsurf',
    'Windsurf',
    (env) => env.path.join(env.home, '.codeium', 'windsurf'),
    'mcp_config.json',
    'mcpServers',
    plain,
  ),
  jsonHarness(
    'devin-desktop',
    'Devin Desktop',
    (env) =>
      env.os === 'win32'
        ? env.path.join(env.appData, 'devin')
        : env.path.join(
            env.os === 'linux' ? env.xdgConfig : env.path.join(env.home, '.config'),
            'devin',
          ),
    'mcp_config.json',
    'mcpServers',
    plain,
  ),
];

/** The JSON most MCP clients take, for anything we don't register automatically. */
export function genericSnippet(cmd: ServerCommand): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: plain(cmd) } }, null, 2);
}

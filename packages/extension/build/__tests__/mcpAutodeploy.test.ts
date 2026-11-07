import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deployHost, deployServer } from '../../../mcp/src/deploy';
import { findHostPids, syncDeployed, type SyncDeps } from '../mcpAutodeploy';

const NODE = '/opt/node/bin/node';

/** A deployed install in a temp folder, and a fake build that writes the given files. */
function setup(built: { host?: string; server?: string } | Error, installed = true) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'mcp-autodeploy-'));
  const dir = path.join(root, 'mcp');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'host.js'), 'host v1');
  fs.writeFileSync(path.join(dir, 'server.js'), 'server v1');
  const info = vi.fn();
  const warn = vi.fn();
  const stopHost = vi.fn(async () => 1);
  const build = vi.fn(async (out: string) => {
    if (built instanceof Error) throw built;
    fs.writeFileSync(path.join(out, 'host.js'), built.host ?? 'host v1');
    fs.writeFileSync(path.join(out, 'server.js'), built.server ?? 'server v1');
  });
  const deps: SyncDeps = {
    installed: async () => (installed ? { dir, nodePath: NODE, os: 'darwin' } : undefined),
    deployHost: vi.fn(deployHost),
    deployServer: vi.fn(deployServer),
    build,
    stopHost,
    info,
    warn,
    tmpDir: root,
  };
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { deps, dir, root, read, info, warn, stopHost, build };
}

describe('syncDeployed', () => {
  it('does nothing when the MCP is not installed', async () => {
    const t = setup({ server: 'server v2' }, false);
    expect(await syncDeployed(t.deps)).toBe('not-installed');
    expect(t.build).not.toHaveBeenCalled();
    expect(t.read('server.js')).toBe('server v1');
  });

  it('copies nothing and logs nothing when the build matches what is deployed', async () => {
    const t = setup({});
    expect(await syncDeployed(t.deps)).toBe('unchanged');
    expect(t.deps.deployHost).not.toHaveBeenCalled();
    expect(t.deps.deployServer).not.toHaveBeenCalled();
    expect(t.info).not.toHaveBeenCalled();
    expect(t.stopHost).not.toHaveBeenCalled();
  });

  it('copies a changed server and asks for an agent restart, leaving the host running', async () => {
    const t = setup({ server: 'server v2' });
    expect(await syncDeployed(t.deps)).toEqual({ server: true, host: false });
    expect(t.read('server.js')).toBe('server v2');
    expect(t.deps.deployHost).not.toHaveBeenCalled();
    expect(t.stopHost).not.toHaveBeenCalled();
    expect(t.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('MCP server updated — restart your agent'),
    );
  });

  it('copies a changed host with the launcher pinned to the installed node, then stops it', async () => {
    const t = setup({ host: 'host v2' });
    expect(await syncDeployed(t.deps)).toEqual({ server: false, host: true });
    expect(t.read('host.js')).toBe('host v2');
    expect(t.read('tab-hammer-host')).toContain(`exec "${NODE}" "${path.join(t.dir, 'host.js')}"`);
    expect(t.stopHost).toHaveBeenCalledExactlyOnceWith(path.join(t.dir, 'host.js'));
    expect(t.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('MCP host updated'));
  });

  it('leaves the deployed copy alone when the build fails, and cleans up its temp folder', async () => {
    const t = setup(new Error('[UNRESOLVED_IMPORT] Could not resolve ./gone.ts'));
    expect(await syncDeployed(t.deps)).toBe('build-failed');
    expect(t.read('host.js')).toBe('host v1');
    expect(t.read('server.js')).toBe('server v1');
    expect(t.stopHost).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('gone.ts'));
    expect(fs.readdirSync(t.root)).toEqual(['mcp']);
  });
});

describe('findHostPids', () => {
  const host = '/Users/me/.tab-hammer/mcp/host.js';

  it('finds only processes running the deployed host, not itself or look-alikes', () => {
    const ps = [
      `  101 /opt/node/bin/node ${host} chrome-extension://abc/`,
      `  102 /opt/node/bin/node ${host}.bak chrome-extension://abc/`,
      `  103 /opt/node/bin/node /Users/me/.tab-hammer/mcp/server.js`,
      `  104 vim ${host}x`,
      `  105 /opt/node/bin/node ${host}`,
    ].join('\n');
    expect(findHostPids(ps, host, 105)).toEqual([101]);
  });

  it('matches a host path containing spaces', () => {
    const spaced = '/Users/Jo Smith/.tab-hammer/mcp/host.js';
    expect(findHostPids(`7 /usr/bin/node ${spaced} chrome-extension://x/`, spaced, 1)).toEqual([7]);
  });
});

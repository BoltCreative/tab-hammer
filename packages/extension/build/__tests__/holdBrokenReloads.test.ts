import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createReloadGate, findLinkError } from '../holdBrokenReloads';

const RELOAD = { type: 'custom', event: 'crx:runtime-reload' };
const UPDATE = { type: 'update', updates: [] };

function gate(results: (string | null)[]) {
  const forward = vi.fn();
  const warn = vi.fn();
  const check = vi.fn(async () => results.shift() ?? null);
  return { forward, warn, check, gate: createReloadGate({ forward, check, warn, info: vi.fn() }) };
}

describe('createReloadGate', () => {
  it('passes other payloads straight through without checking', async () => {
    const g = gate([]);
    g.gate.send(UPDATE);
    await g.gate.settled();
    expect(g.forward).toHaveBeenCalledWith(UPDATE);
    expect(g.check).not.toHaveBeenCalled();
  });

  it('sends the reload when the service worker links', async () => {
    const g = gate([null]);
    g.gate.send(RELOAD);
    await g.gate.settled();
    expect(g.forward).toHaveBeenCalledWith(RELOAD);
  });

  it('holds the reload while the code is broken, and sends it once a change fixes it', async () => {
    const g = gate(['MISSING_EXPORT', 'MISSING_EXPORT', null]);
    g.gate.send(RELOAD);
    await g.gate.settled();
    expect(g.forward).not.toHaveBeenCalled();
    expect(g.warn).toHaveBeenCalledOnce();

    g.gate.fileChanged(); // still broken
    await g.gate.settled();
    expect(g.forward).not.toHaveBeenCalled();
    expect(g.warn).toHaveBeenCalledOnce(); // warns once per broken stretch

    g.gate.fileChanged(); // fixed
    await g.gate.settled();
    expect(g.forward).toHaveBeenCalledExactlyOnceWith(RELOAD);
  });

  it('sends one reload for a burst of changes', async () => {
    const g = gate([null, null, null]);
    g.gate.send(RELOAD);
    g.gate.send(RELOAD);
    g.gate.send(RELOAD);
    await g.gate.settled();
    expect(g.forward).toHaveBeenCalledOnce();
  });

  it('does nothing on file changes when no reload is held', async () => {
    const g = gate([]);
    g.gate.fileChanged();
    await g.gate.settled();
    expect(g.check).not.toHaveBeenCalled();
  });
});

describe('findLinkError', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'link-check-'));
  const file = (name: string, code: string) => {
    writeFileSync(path.join(dir, name), code);
    return path.join(dir, name);
  };
  file('dep.ts', 'export const kept = 1;\n');

  it('passes code whose imports all resolve (packages are left to Vite)', async () => {
    const entry = file('ok.ts', "import { kept } from './dep.ts';\nimport 'some-pkg';\nkept;\n");
    expect(await findLinkError(entry)).toBeNull();
  });

  it('catches an import of an export that no longer exists', async () => {
    const entry = file('missing.ts', "import { gone } from './dep.ts';\ngone;\n");
    expect(await findLinkError(entry)).toMatch(/gone/);
  });

  it('catches a syntax error', async () => {
    const entry = file('syntax.ts', 'export const x = (;\n');
    expect(await findLinkError(entry)).not.toBeNull();
  });

  // A false alarm here would hold every reload in dev, so check the real service worker links.
  it('passes the real service worker', async () => {
    const entry = path.resolve(import.meta.dirname, '../../src/background/index.ts');
    expect(await findLinkError(entry)).toBeNull();
  });
});

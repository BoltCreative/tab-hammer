// This package's version, and the newest one on npm, so doctor can say when an update is out.
// Install copies the server out of the package (deploy.ts), so a newer npm release only reaches
// a machine when someone re-runs install. Only doctor asks npm; the server never touches the network.
import pkg from '../../package.json' with { type: 'json' };

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;

/** The newest published version, or undefined if npm can't be reached or it isn't published. */
export async function latestVersion(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `a` is a newer x.y.z than `b` (prerelease tags are ignored). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

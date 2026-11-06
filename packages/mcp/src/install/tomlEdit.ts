// Adds and removes one `[table]` in a TOML config (Codex's config.toml) as plain text, the same way
// jsonEdit.ts does for JSON: install appends one run of text and remembers it, uninstall cuts that
// run back out. Only the subset we write is understood: a table header and `key = value` lines.

export interface TomlInsertion {
  createdFile: boolean;
  text: string;
  replaced?: boolean;
}

/** A TOML basic string. JSON's escapes are all valid TOML escapes. */
export const tomlString = (s: string): string => JSON.stringify(s);

export function tomlTable(header: string, entries: Record<string, string | string[]>): string {
  const lines = [`[${header}]`];
  for (const [k, v] of Object.entries(entries)) {
    lines.push(`${k} = ${Array.isArray(v) ? `[${v.map(tomlString).join(', ')}]` : tomlString(v)}`);
  }
  return lines.join('\n') + '\n';
}

const headerLine = (header: string) =>
  new RegExp(`^\\s*\\[\\s*${escapeRe(header)}\\s*\\]\\s*(#.*)?$`);
const anyHeader = /^\s*\[/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** [start, end) line indexes of the table, header through the line before the next table. */
function findTable(lines: string[], header: string): [number, number] | undefined {
  const re = headerLine(header);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !anyHeader.test(lines[end]!)) end++;
  // Leave trailing blank lines to whatever follows.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--;
  return [start, end];
}

export function hasTable(text: string, header: string): boolean {
  return findTable(text.split('\n'), header) !== undefined;
}

/** Reads the `key = "string"` / `key = ["a", "b"]` values of a table (enough for doctor). */
export function readTable(text: string, header: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/);
  const range = findTable(lines, header);
  if (!range) return undefined;
  const out: Record<string, unknown> = {};
  for (const line of lines.slice(range[0] + 1, range[1])) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    try {
      out[m[1]!] = JSON.parse(m[2]!);
    } catch {
      out[m[1]!] = m[2];
    }
  }
  return out;
}

export function insertTable(
  text: string,
  header: string,
  table: string,
  previous?: TomlInsertion,
): { text: string; insertion: TomlInsertion } {
  if (previous) {
    const back = removeTable(text, header, previous);
    if (back.removedExactly) {
      const again = insertTable(back.text, header, table);
      return {
        text: again.text,
        insertion: { ...again.insertion, replaced: previous.replaced ?? again.insertion.replaced },
      };
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = table.split('\n').join(eol);
  if (!text.trim()) {
    return { text: text + body, insertion: { createdFile: text === '', text: body } };
  }
  const lines = text.split('\n');
  const range = findTable(lines, header);
  if (range) {
    // Someone else's table under our name: replace its lines.
    const replacement = body.replace(new RegExp(`${eol}$`), '').split('\n');
    lines.splice(range[0], range[1] - range[0], ...replacement);
    return { text: lines.join('\n'), insertion: { createdFile: false, text: '', replaced: true } };
  }
  const sep = text.endsWith(eol) ? eol : eol + eol;
  const added = sep + body;
  return { text: text + added, insertion: { createdFile: false, text: added } };
}

export function removeTable(
  text: string,
  header: string,
  insertion?: TomlInsertion,
): { text: string; deleteFile: boolean; removedExactly: boolean; found: boolean } {
  if (insertion?.createdFile && text === insertion.text) {
    return { text: '', deleteFile: true, removedExactly: true, found: true };
  }
  if (insertion && !insertion.replaced && insertion.text) {
    const at = text.indexOf(insertion.text);
    if (at !== -1 && text.indexOf(insertion.text, at + 1) === -1) {
      const next = text.slice(0, at) + text.slice(at + insertion.text.length);
      if (!hasTable(next, header)) {
        return { text: next, deleteFile: false, removedExactly: true, found: true };
      }
    }
  }
  const lines = text.split('\n');
  const range = findTable(lines, header);
  if (!range) return { text, deleteFile: false, removedExactly: false, found: false };
  const end = range[1];
  let start = range[0];
  // Take one blank line before it along, so removal doesn't leave a double gap.
  if (start > 0 && lines[start - 1]!.trim() === '') start--;
  lines.splice(start, end - start);
  const next = lines.join('\n');
  return {
    text: next,
    deleteFile: !!insertion?.createdFile && next.trim() === '',
    removedExactly: false,
    found: true,
  };
}

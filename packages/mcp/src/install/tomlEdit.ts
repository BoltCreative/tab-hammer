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

/** Matches the header line of `header`, or with `sub` also of its sub-tables (`[header.env]`). */
function headerRe(header: string, sub = false): RegExp {
  // Each dotted segment may be bare or quoted: [mcp_servers.tab-hammer] or [mcp_servers."tab-hammer"].
  const segs = header
    .split('.')
    .map((seg) => `(?:${escapeRe(seg)}|"${escapeRe(seg)}"|'${escapeRe(seg)}')`);
  const tail = sub ? `(?:\\s*\\.[^\\]]*)?` : '';
  return new RegExp(`^\\s*\\[\\s*${segs.join('\\s*\\.\\s*')}${tail}\\s*\\]\\s*(#.*)?\\r?$`);
}
const anyHeader = /^\s*\[/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** [start, end) line indexes of a table, header through the line before the next table. */
function tableAt(lines: string[], start: number): [number, number] {
  let end = start + 1;
  while (end < lines.length && !anyHeader.test(lines[end]!)) end++;
  // Leave trailing blank lines to whatever follows.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--;
  return [start, end];
}

function findTable(lines: string[], header: string): [number, number] | undefined {
  const re = headerRe(header);
  const start = lines.findIndex((l) => re.test(l));
  return start === -1 ? undefined : tableAt(lines, start);
}

/** The table and every sub-table of it (`[header.env]`), last first so they splice cleanly. */
function findTableAndSubs(lines: string[], header: string): [number, number][] {
  const re = headerRe(header, true);
  const out: [number, number][] = [];
  lines.forEach((l, i) => {
    if (re.test(l)) out.push(tableAt(lines, i));
  });
  return out.reverse();
}

export function hasTable(text: string, header: string): boolean {
  return findTableAndSubs(text.split('\n'), header).length > 0;
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
    if (findTable(text.split('\n'), header)) {
      // Our table, edited since: replace it in place and keep what the first install recorded.
      return { text: replaceTable(text, header, table), insertion: previous };
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = table.split('\n').join(eol);
  if (!text.trim()) {
    return { text: text + body, insertion: { createdFile: text === '', text: body } };
  }
  if (findTable(text.split('\n'), header)) {
    // Someone else's table under our name: replace its lines.
    return {
      text: replaceTable(text, header, table),
      insertion: { createdFile: false, text: '', replaced: true },
    };
  }
  const sep = text.endsWith(eol) ? eol : eol + eol;
  const added = sep + body;
  return { text: text + added, insertion: { createdFile: false, text: added } };
}

function replaceTable(text: string, header: string, table: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n');
  const [start, end] = findTable(lines, header)!;
  // Split like the file's lines are, so a CRLF file keeps its \r on every replaced line.
  const replacement = table.split('\n').join(eol).split('\n').slice(0, -1);
  lines.splice(start, end - start, ...replacement);
  return lines.join('\n');
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
    const rest = at === -1 ? '' : text.slice(at + insertion.text.length);
    // Only cut if nothing was added under our table since: what follows must be the end of the
    // file or another table's header (not one of ours, like [mcp_servers.tab-hammer.env]).
    const firstAfter = rest.split('\n').find((l) => l.trim() !== '');
    const untouched =
      firstAfter === undefined ||
      (anyHeader.test(firstAfter) && !headerRe(header, true).test(firstAfter));
    if (at !== -1 && untouched && text.indexOf(insertion.text, at + 1) === -1) {
      const next = text.slice(0, at) + rest;
      if (!hasTable(next, header)) {
        return { text: next, deleteFile: false, removedExactly: true, found: true };
      }
    }
  }
  const lines = text.split('\n');
  const ranges = findTableAndSubs(lines, header);
  if (!ranges.length) return { text, deleteFile: false, removedExactly: false, found: false };
  for (const [s0, end] of ranges) {
    let start = s0;
    // Take one blank line before it along, so removal doesn't leave a double gap.
    if (start > 0 && lines[start - 1]!.trim() === '') start--;
    lines.splice(start, end - start);
  }
  const next = lines.join('\n');
  return {
    text: next,
    deleteFile: !!insertion?.createdFile && next.trim() === '',
    removedExactly: false,
    found: true,
  };
}

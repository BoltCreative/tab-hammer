// Adds and removes one server entry in a JSON (or JSONC) config file without touching anything
// else in it. Install inserts one contiguous run of text and remembers it; uninstall cuts exactly
// that run back out, so a file nobody else edited in between comes back byte for byte. If someone
// did reformat it, uninstall falls back to removing the entry structurally.
import { applyEdits, modify, parseTree, findNodeAtLocation, type Node } from 'jsonc-parser';

/** What install did to one file, kept in the install state so uninstall can undo exactly that. */
export interface JsonInsertion {
  /** The file didn't exist (or was blank) and install wrote the whole of `text`. */
  createdFile: boolean;
  /** The exact text install inserted (the whole file when createdFile). */
  text: string;
  /** The entry existed before install (not written by us), so install replaced its value. */
  replaced?: boolean;
  /** Install added the container object too, so uninstall drops it if it's left empty. */
  addedContainer?: boolean;
}

export class ConfigFormatError extends Error {}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The indentation unit the file uses, from its first indented line. Two spaces if none. */
function detectIndentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : '  ';
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

function render(value: unknown, unit: string, baseIndent: string, eol: string): string {
  return JSON.stringify(value, null, unit)
    .split('\n')
    .join(eol + baseIndent);
}

function parseRoot(text: string): Node {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root || root.type !== 'object') {
    throw new ConfigFormatError('the file is not a JSON object');
  }
  return root;
}

/**
 * Text that inserts `"key": value` as the first member of `obj` (so trailing commas elsewhere
 * don't matter), plus where it goes.
 */
function memberInsertion(
  text: string,
  obj: Node,
  key: string,
  value: unknown,
): { offset: number; text: string } {
  const eol = detectEol(text);
  const unit = detectIndentUnit(text);
  const first = obj.children?.[0];
  if (first) {
    const indent = lineIndent(text, first.offset);
    const sameLine = text.lastIndexOf('\n', first.offset - 1) < obj.offset;
    const memberIndent = sameLine ? lineIndent(text, obj.offset) + unit : indent;
    const member = `${JSON.stringify(key)}: ${render(value, unit, memberIndent, eol)}`;
    // An object written on one line ({"a": 1}) gets the new member on its own line too.
    return sameLine
      ? { offset: obj.offset + 1, text: `${eol}${memberIndent}${member},${eol}${memberIndent}` }
      : { offset: first.offset, text: `${member},${eol}${indent}` };
  }
  const outer = lineIndent(text, obj.offset);
  const memberIndent = outer + unit;
  const member = `${JSON.stringify(key)}: ${render(value, unit, memberIndent, eol)}`;
  // `{}` or `{ }` or `{\n}`: put the member on its own line after the brace.
  const close = obj.offset + obj.length - 1;
  const inner = text.slice(obj.offset + 1, close);
  const closeOnOwnLine = inner.includes('\n');
  return {
    offset: obj.offset + 1,
    text: `${eol}${memberIndent}${member}${closeOnOwnLine ? '' : eol + outer}`,
  };
}

/** The entry at `container.key`, or undefined. */
export function readEntry(text: string, container: string, key: string): unknown {
  if (!text.trim()) return undefined;
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || root.type !== 'object') return undefined;
  const node = findNodeAtLocation(root, [container, key]);
  return node ? jsonValue(node) : undefined;
}

function jsonValue(node: Node): unknown {
  switch (node.type) {
    case 'object':
      return Object.fromEntries(
        (node.children ?? []).map((p) => [
          p.children![0]!.value as string,
          jsonValue(p.children![1]!),
        ]),
      );
    case 'array':
      return (node.children ?? []).map(jsonValue);
    default:
      return node.value;
  }
}

/**
 * Sets `container.key` to `value` in `text` (the file's current contents, '' if absent). Returns
 * the new contents and what to remember for removal. `previous` is what an earlier install
 * recorded, so re-installing swaps our own text in place instead of stacking a second copy.
 */
export function insertEntry(
  text: string,
  container: string,
  key: string,
  value: unknown,
  previous?: JsonInsertion,
): { text: string; insertion: JsonInsertion } {
  if (previous) {
    const back = removeEntry(text, container, key, previous);
    if (back.removedExactly) {
      const again = insertEntry(back.text, container, key, value);
      return {
        text: again.text,
        insertion: { ...again.insertion, replaced: previous.replaced ?? again.insertion.replaced },
      };
    }
  }

  if (!text.trim()) {
    // No file, or only whitespace: write a whole object after whatever was there.
    const eol = detectEol(text);
    const body = render({ [container]: { [key]: value } }, '  ', '', eol) + eol;
    return {
      text: text + body,
      insertion: { createdFile: text === '', text: body, addedContainer: true },
    };
  }

  const root = parseRoot(text);
  const existing = findNodeAtLocation(root, [container, key]);
  if (existing) {
    const fo = {
      insertSpaces: !detectIndentUnit(text).includes('\t'),
      tabSize: 2,
      eol: detectEol(text),
    };
    const next = applyEdits(text, modify(text, [container, key], value, { formattingOptions: fo }));
    // Our own entry, edited since the first install: keep what that install recorded. Otherwise
    // it's someone else's entry under our name (the old repo installer, or hand-written).
    return {
      text: next,
      insertion:
        previous && !previous.replaced
          ? previous
          : { createdFile: false, text: '', replaced: true },
    };
  }

  const holder = findNodeAtLocation(root, [container]);
  if (holder && holder.type !== 'object') {
    throw new ConfigFormatError(`"${container}" is not an object`);
  }
  const ins = holder
    ? memberInsertion(text, holder, key, value)
    : memberInsertion(text, root, container, { [key]: value });
  return {
    text: text.slice(0, ins.offset) + ins.text + text.slice(ins.offset),
    insertion: { createdFile: false, text: ins.text, addedContainer: !holder },
  };
}

/**
 * Removes `container.key`. With the insertion install recorded, cuts out exactly that text if it's
 * still there (byte-identical undo); otherwise removes the member structurally. `deleteFile` means
 * install created the file and nothing else has been added since.
 */
export function removeEntry(
  text: string,
  container: string,
  key: string,
  insertion?: JsonInsertion,
): { text: string; deleteFile: boolean; removedExactly: boolean; found: boolean } {
  if (insertion?.createdFile && text === insertion.text) {
    return { text: '', deleteFile: true, removedExactly: true, found: true };
  }
  if (insertion && !insertion.replaced && insertion.text && !insertion.createdFile) {
    const at = text.indexOf(insertion.text);
    if (at !== -1 && text.indexOf(insertion.text, at + 1) === -1) {
      const next = text.slice(0, at) + text.slice(at + insertion.text.length);
      // Only trust the cut if the entry is really gone and the rest still parses.
      // (A file that was only whitespace before install is only whitespace again.)
      if (!next.trim() || (readEntry(next, container, key) === undefined && safeParse(next))) {
        return { text: next, deleteFile: false, removedExactly: true, found: true };
      }
    }
  }
  if (readEntry(text, container, key) === undefined) {
    return { text, deleteFile: false, removedExactly: false, found: false };
  }
  const fo = {
    insertSpaces: !detectIndentUnit(text).includes('\t'),
    tabSize: 2,
    eol: detectEol(text),
  };
  let next = applyEdits(text, modify(text, [container, key], undefined, { formattingOptions: fo }));
  if (insertion?.addedContainer) {
    // We added the container too: drop it if we leave it empty.
    const root = parseTree(next);
    const holder = root && findNodeAtLocation(root, [container]);
    if (holder?.type === 'object' && !holder.children?.length) {
      next = applyEdits(next, modify(next, [container], undefined, { formattingOptions: fo }));
    }
  }
  const empty = (() => {
    const root = parseTree(next);
    return root?.type === 'object' && !root.children?.length;
  })();
  return {
    text: next,
    deleteFile: !!insertion?.createdFile && empty,
    removedExactly: false,
    found: true,
  };
}

function safeParse(text: string): boolean {
  const root = parseTree(text, [], { allowTrailingComma: true });
  return root?.type === 'object';
}

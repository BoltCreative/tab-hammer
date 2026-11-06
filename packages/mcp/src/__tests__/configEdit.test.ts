// The config writers: adding our server entry and taking it back out leaves a file exactly as it
// was, whatever its formatting, and leaves everything else in it alone.
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { insertEntry, readEntry, removeEntry } from '../install/jsonEdit.ts';
import { insertTable, readTable, removeTable, tomlTable } from '../install/tomlEdit.ts';

const ENTRY = { command: '/usr/local/bin/node', args: ['/Users/ada/.tab-hammer/mcp/server.js'] };

const JSON_FILES: Record<string, string> = {
  empty: '',
  'only whitespace': '\n',
  'empty object': '{}',
  'empty object, newline': '{}\n',
  'empty container': '{\n  "mcpServers": {}\n}\n',
  'empty container, multi-line': '{\n  "mcpServers": {\n  }\n}\n',
  'other servers': '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
  'other settings, no container': '{\n    "theme": "dark",\n    "fontSize": 13\n}',
  'one line': '{"theme":"dark","mcpServers":{"a":{"command":"x"}}}',
  'one line, no container': '{"theme":"dark"}',
  tabs: '{\n\t"mcpServers": {\n\t\t"a": {\n\t\t\t"command": "x"\n\t\t}\n\t}\n}\n',
  CRLF: '{\r\n  "mcpServers": {\r\n    "a": { "command": "x" }\r\n  }\r\n}\r\n',
  'JSONC: comments and trailing commas':
    '{\n  // my servers\n  "mcpServers": {\n    "a": { "command": "x" }, // keep\n  },\n  /* end */\n}\n',
};

describe('JSON config entries', () => {
  for (const [name, original] of Object.entries(JSON_FILES)) {
    it(`round-trips byte for byte: ${name}`, () => {
      const { text, insertion } = insertEntry(original, 'mcpServers', 'tab-hammer', ENTRY);
      const parsed = parse(text, [], { allowTrailingComma: true }) as {
        mcpServers: Record<string, unknown>;
      };
      expect(parsed.mcpServers['tab-hammer']).toEqual(ENTRY);
      const before = original.trim()
        ? (parse(original, [], { allowTrailingComma: true }) as object)
        : {};
      // Nothing else changed.
      const others = { ...parsed.mcpServers };
      delete others['tab-hammer'];
      expect({ ...parsed, mcpServers: others }).toMatchObject({
        ...before,
        mcpServers: (before as { mcpServers?: object }).mcpServers ?? {},
      });

      const back = removeEntry(text, 'mcpServers', 'tab-hammer', insertion);
      expect(back.removedExactly).toBe(true);
      if (back.deleteFile) expect(original).toBe('');
      else expect(back.text).toBe(original);
    });
  }

  it('re-installing swaps our entry in place instead of adding a second one', () => {
    const original = JSON_FILES['other servers']!;
    const first = insertEntry(original, 'mcpServers', 'tab-hammer', ENTRY);
    const newer = { ...ENTRY, command: '/opt/node' };
    const second = insertEntry(first.text, 'mcpServers', 'tab-hammer', newer, first.insertion);
    expect(readEntry(second.text, 'mcpServers', 'tab-hammer')).toEqual(newer);
    expect(second.text.match(/tab-hammer"/g)).toHaveLength(1);
    expect(removeEntry(second.text, 'mcpServers', 'tab-hammer', second.insertion).text).toBe(
      original,
    );
  });

  it('replaces an entry of the same name it did not write, and removes it on uninstall', () => {
    const original =
      '{\n  "mcpServers": {\n    "tab-hammer": { "command": "old" },\n    "a": {}\n  }\n}\n';
    const { text, insertion } = insertEntry(original, 'mcpServers', 'tab-hammer', ENTRY);
    expect(insertion.replaced).toBe(true);
    expect(readEntry(text, 'mcpServers', 'tab-hammer')).toEqual(ENTRY);
    const back = removeEntry(text, 'mcpServers', 'tab-hammer', insertion);
    expect(readEntry(back.text, 'mcpServers', 'tab-hammer')).toBeUndefined();
    expect(readEntry(back.text, 'mcpServers', 'a')).toEqual({});
  });

  it('still removes the entry after the user reformatted the file', () => {
    const { text, insertion } = insertEntry(
      JSON_FILES['other servers']!,
      'mcpServers',
      'tab-hammer',
      ENTRY,
    );
    const reformatted = JSON.stringify(JSON.parse(text)); // one line now
    const back = removeEntry(reformatted, 'mcpServers', 'tab-hammer', insertion);
    expect(back.removedExactly).toBe(false);
    expect(JSON.parse(back.text)).toEqual({ mcpServers: { github: { command: 'gh-mcp' } } });
  });

  it('keeps a file it created if the user added to it, minus our entry', () => {
    const { text, insertion } = insertEntry('', 'mcpServers', 'tab-hammer', ENTRY);
    const edited = text.replace('"mcpServers": {', '"mcpServers": {\n    "mine": {},');
    const back = removeEntry(edited, 'mcpServers', 'tab-hammer', insertion);
    expect(back.deleteFile).toBe(false);
    expect(JSON.parse(back.text)).toEqual({ mcpServers: { mine: {} } });
  });

  it('works with VS Code’s "servers" key next to its "inputs"', () => {
    const original = '{\n  "inputs": [],\n  "servers": {}\n}\n';
    const vs = { type: 'stdio', ...ENTRY };
    const { text, insertion } = insertEntry(original, 'servers', 'tab-hammer', vs);
    expect(JSON.parse(text)).toEqual({ inputs: [], servers: { 'tab-hammer': vs } });
    expect(removeEntry(text, 'servers', 'tab-hammer', insertion).text).toBe(original);
  });

  it('refuses a file that is not a JSON object', () => {
    expect(() => insertEntry('[1, 2]', 'mcpServers', 'tab-hammer', ENTRY)).toThrow(
      /not a JSON object/,
    );
    expect(() => insertEntry('{"mcpServers": 3}', 'mcpServers', 'tab-hammer', ENTRY)).toThrow(
      /not an object/,
    );
  });
});

const TABLE = tomlTable('mcp_servers.tab-hammer', {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\Users\\ada\\AppData\\Local\\TabHammer\\mcp\\server.js'],
});

const TOML_FILES: Record<string, string> = {
  empty: '',
  'only whitespace': '\n',
  'settings, trailing newline': 'model = "o4"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n',
  'no trailing newline': 'model = "o4"',
  CRLF: 'model = "o4"\r\n[tui]\r\nnotifications = true\r\n',
};

describe('TOML config tables (Codex)', () => {
  for (const [name, original] of Object.entries(TOML_FILES)) {
    it(`round-trips byte for byte: ${name}`, () => {
      const { text, insertion } = insertTable(original, 'mcp_servers.tab-hammer', TABLE);
      expect(readTable(text, 'mcp_servers.tab-hammer')).toEqual({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Users\\ada\\AppData\\Local\\TabHammer\\mcp\\server.js'],
      });
      const back = removeTable(text, 'mcp_servers.tab-hammer', insertion);
      expect(back.removedExactly).toBe(true);
      if (back.deleteFile) expect(original).toBe('');
      else expect(back.text).toBe(original);
    });
  }

  it('re-installing replaces our table instead of adding another', () => {
    const original = TOML_FILES['settings, trailing newline']!;
    const first = insertTable(original, 'mcp_servers.tab-hammer', TABLE);
    const second = insertTable(first.text, 'mcp_servers.tab-hammer', TABLE, first.insertion);
    expect(second.text).toBe(first.text);
    expect(removeTable(second.text, 'mcp_servers.tab-hammer', second.insertion).text).toBe(
      original,
    );
  });

  it('removes our table when the user added more config after it', () => {
    const { text, insertion } = insertTable('model = "o4"\n', 'mcp_servers.tab-hammer', TABLE);
    const edited = text + '\n[tui]\nnotifications = true\n';
    const back = removeTable(edited, 'mcp_servers.tab-hammer', insertion);
    expect(back.text).toBe('model = "o4"\n\n[tui]\nnotifications = true\n');
  });

  it('recognises a quoted table name, and removes sub-tables with it', () => {
    const original =
      'model = "o4"\n\n[mcp_servers."tab-hammer"]\ncommand = "old"\n\n[mcp_servers.tab-hammer.env]\nX = "1"\n';
    const { text, insertion } = insertTable(original, 'mcp_servers.tab-hammer', TABLE);
    expect(insertion.replaced).toBe(true);
    expect(text.match(/\[mcp_servers\.("?)tab-hammer\1\]/g)).toHaveLength(1);
    expect(removeTable(text, 'mcp_servers.tab-hammer', insertion).text).toBe('model = "o4"\n');
  });

  it('replaces a table of the same name it did not write', () => {
    const original = '[mcp_servers.tab-hammer]\ncommand = "old"\n\n[tui]\nx = 1\n';
    const { text, insertion } = insertTable(original, 'mcp_servers.tab-hammer', TABLE);
    expect(insertion.replaced).toBe(true);
    expect(readTable(text, 'mcp_servers.tab-hammer')?.command).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
    expect(text).toContain('[tui]\nx = 1');
  });
});

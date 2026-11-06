// The MCP server Claude Code starts (over stdio). Each tool forwards one call to Tab Hammer in
// Chrome through the native host. Claude Code asks the user before running any MCP tool unless they
// have allowed it, which is the guard on destructive ones like close_tabs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GROUP_COLORS, type GroupColor, type Method, type Methods } from '@tab-hammer/protocol';
import { z } from 'zod';
import { callBridge } from './bridgeClient.ts';
import pkg from '../package.json' with { type: 'json' };

const tabIds = z.array(z.number().int()).min(1).describe('Tab IDs from list_tabs');
const color = z.enum(GROUP_COLORS as [GroupColor, ...GroupColor[]]);

export function createServer(socketPath: string): McpServer {
  const server = new McpServer({ name: 'tab-hammer', version: pkg.version });

  const run = async <M extends Method>(method: M, params: Methods[M]['params']) => {
    try {
      const result = await callBridge(socketPath, method, params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? 'ok') }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  };

  server.registerTool(
    'list_tabs',
    {
      title: 'List tabs',
      description:
        "Every open Chrome window with its tab groups and tabs, in tab-strip order (Tab Hammer's " +
        "own window excluded). Gives the IDs the other tools take, plus each tab's title, URL, " +
        'and when the user last viewed it. IDs change when Chrome restarts, so list again rather ' +
        'than reusing old ones.',
      annotations: { readOnlyHint: true },
    },
    () => run('list_tabs', {}),
  );

  server.registerTool(
    'focus_tab',
    {
      title: 'Focus tab',
      description: 'Bring a tab to the front: select it in its window and focus that window.',
      inputSchema: { tabId: z.number().int() },
    },
    (args) => run('focus_tab', args),
  );

  server.registerTool(
    'open_tabs',
    {
      title: 'Open tabs',
      description: 'Open URLs as new tabs, in an existing window or (no windowId) a new window.',
      inputSchema: {
        urls: z.array(z.string()).min(1),
        windowId: z.number().int().optional(),
      },
    },
    (args) => run('open_tabs', args),
  );

  server.registerTool(
    'move_tabs',
    {
      title: 'Move tabs',
      description:
        'Move tabs, in the given order, into a window (no windowId: a new window). `index` is the ' +
        'position in that window; omit it to append. Moving a tab out of its group ungroups it.',
      inputSchema: {
        tabIds,
        windowId: z.number().int().optional(),
        index: z.number().int().min(0).optional(),
      },
    },
    (args) => run('move_tabs', args),
  );

  server.registerTool(
    'group_tabs',
    {
      title: 'Group tabs',
      description:
        'Put tabs in a tab group: an existing one (groupId) or a new one, optionally titled and ' +
        "colored. Tabs from other windows move into the group's window. Returns the groupId.",
      inputSchema: {
        tabIds,
        groupId: z.number().int().optional(),
        title: z.string().optional(),
        color: color.optional(),
      },
    },
    (args) => run('group_tabs', args),
  );

  server.registerTool(
    'ungroup_tabs',
    {
      title: 'Ungroup tabs',
      description: 'Take tabs out of their groups (the tabs stay open).',
      inputSchema: { tabIds },
    },
    (args) => run('ungroup_tabs', args),
  );

  server.registerTool(
    'update_group',
    {
      title: 'Update group',
      description: "Rename, recolor, or collapse/expand a tab group in Chrome's tab strip.",
      inputSchema: {
        groupId: z.number().int(),
        title: z.string().optional(),
        color: color.optional(),
        collapsed: z.boolean().optional(),
      },
    },
    (args) => run('update_group', args),
  );

  server.registerTool(
    'close_tabs',
    {
      title: 'Close tabs',
      description: 'Close tabs. They can be reopened from Chrome history, but not by this tool.',
      inputSchema: { tabIds },
      annotations: { destructiveHint: true },
    },
    (args) => run('close_tabs', args),
  );

  return server;
}

export async function runMcpServer(socketPath: string): Promise<void> {
  await createServer(socketPath).connect(new StdioServerTransport());
}

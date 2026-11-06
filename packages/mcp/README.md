# tab-hammer-mcp

An MCP server that lets AI agents list, group, move, focus, open, and close browser tabs through
the [Tab Hammer](https://github.com/BoltCreative/tab-hammer) browser extension.

With the extension installed, run (Node 20 or newer):

```
npx tab-hammer-mcp install
```

It registers Tab Hammer's native messaging host with every Chromium browser it finds (Chrome,
Chrome Beta/Dev/Canary, Chromium, Brave, Edge, Arc) and this server with every agent it finds
(Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Devin Desktop), on macOS, Linux,
and Windows. For any other agent it prints the config to paste. Then reload Tab Hammer in the
browser and restart the agent.

- `npx tab-hammer-mcp doctor` checks each browser's registration, whether the extension is
  connected, and each agent's config, and says how to fix what's wrong.
- `npx tab-hammer-mcp uninstall` undoes exactly what install did.
- `--only <ids>` / `--skip <ids>` limit either command to some targets (`--help` lists them).
- `--extension-id <id>` also allows another build of the extension.
- `npx tab-hammer-mcp` with no command runs the server over stdio.

The browser runs the host, which relays between the extension and this server over a local
socket (a per-user named pipe on Windows). Both are copied to `~/.tab-hammer/mcp`
(`%LOCALAPPDATA%\TabHammer\mcp` on Windows) and run with the `node` you installed with.

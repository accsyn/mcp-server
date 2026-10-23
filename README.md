# accsyn MCP server

Local [MCP](https://modelcontextprotocol.io) server for the accsyn workspace API. It speaks stdio, so an agent runs it on your machine. It is not a hosted service.

This first version lists transfers. Deliveries, queues, and compute jobs are left out.

## Listing transfers

There is one tool, `transfer_list`, and every filter is an optional argument. Filters that are given must all match. Clients such as ChatGPT and Claude use tools, so the tool is the main interface.

| Argument | Meaning |
| --- | --- |
| `user` | Email of the user who created the transfers, for example `john@user.com`. Left out, it covers every user the account can see. |
| `state` | `active` (default, not finished yet), `finished` (status `done` or `aborted`), or `all`. |
| `status` | One status or a list, for example `["running","paused"]`. Known statuses: `pending`, `waiting`, `running`, `paused`, `failed`, `aborted`, `done`. |
| `source` | The sending party. Use it for "downloaded from X" and "uploaded by X". |
| `destination` | The receiving party. Use it for "uploaded to X" and "downloaded by X". |
| `created_after`, `created_before` | ISO date or date time, for example `2026-10-01` or `2026-10-01T12:00:00Z`. A date alone means 00:00 UTC. |
| `finished_after`, `finished_before` | The same, for the time the transfer finished. |
| `limit` | Number of transfers to return. Default 50, at most 200. |

The result has `transfers`, most recent first (by finish time for `finished`, otherwise by creation time), plus `count`, `total` (matches before `limit`), `truncated`, and the `filters` that were applied.

Examples of what to ask:

- `List all active transfers for john@user.com`
- `Which transfers were aborted since 12 October?`
- `Show john@user.com's finished transfers from last week`
- `Find all transfers uploaded to site london by tom@berlinvfx.com` (`source: "user:tom@berlinvfx.com"`, `destination: "site:london"`)

A party is `user:<email>` for a remote user, `site:<name>` for a site, or `workspace` for the workspace itself (the main site, HQ). The text after the colon only has to be contained in the party name, ignoring case, so `site:lond` finds `london`. `user:`, `site:` or `workspace` alone matches any party of that type, and text without a type matches a party of any type. Only the name is compared: the `[role]` and `(id)` parts of the human readable form are ignored.

The server reads both the type and the name from `source_hr` and `destination_hr`, which start with the party type, for example `user:lisa@example.com[standard](id)` or `site:london`.

`user` and `status` are matched by the accsyn backend. The parties and the dates are compared by the MCP server after the backend answers, because the backend query only matches whole values and compares text. The backend caps how many finished transfers it returns, so with only a party or date filter the oldest finished ones may be missing. Narrow with `user` or `status` first to get everything.

### Resources

Two shortcuts are also offered as resources, for clients that read resources. A resource URI cannot carry optional filters, so these only take a user. Use the tool for anything else.

| Resource | URI |
| --- | --- |
| `transfer.list` (active) | `accsyn://transfer/list/john@user.com` |
| `transfer.list_finished` | `accsyn://transfer/finished/john@user.com` |

### Adding a filter

Add a field to `TransferFilters` in `src/transfers.ts` and a matching optional argument to the tool in `src/index.ts`. A new tool or resource is not needed.

## Configure

The server uses the [`accsyn`](https://www.npmjs.com/package/accsyn) session. All three values are required. `Session.connect` cannot open a workspace with only an API key.

```json
{
  "mcpServers": {
    "accsyn": {
      "command": "npx",
      "args": ["-y", "@accsyn/mcp-server"],
      "env": {
        "ACCSYN_WORKSPACE": "acmefilm",
        "ACCSYN_API_USER": "john@user.com",
        "ACCSYN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Set `AS_DEV=true` in `env` to talk to a local dev backend instance on `127.0.0.1:8181`.

## Test in ChatGPT

ChatGPT can launch a local stdio server itself, so no tunnel or HTTP server is needed.

What you need:

- The accsyn backend running in dev mode on `127.0.0.1:8181`.
- `npm run build` in this repository, so `dist/index.js` exists.

In ChatGPT, open the settings and choose Connect to a custom MCP. Enter:

- Name: `accsyn`
- Command to launch:

```bash
/path/to/node
```

- Argument:

```bash
/absolute/path/to/mcp-server/git/dist/index.js
```

- Environment variables:

| Name | Value |
| --- | --- |
| `AS_DEV` | `true` |
| `ACCSYN_WORKSPACE` | `acmefilm` |
| `ACCSYN_API_USER` | `john@user.com` |
| `ACCSYN_API_KEY` | `your-api-key` |

Use the absolute path to `dist/index.js`, because ChatGPT does not start the server from this folder. Leave `AS_DEV` out to use your real workspace instead of the local backend.

Once the package is on npm, the command can be `npx -y @accsyn/mcp-server` with the same variables.

Save it, restart ChatGPT, start a new chat, and ask: `List all active transfers for john@user.com`. ChatGPT calls the `transfer_list` tool, which reads the active transfers for that user from the backend on port 8181. Ask `List finished transfers for john@user.com` to make it use `state: "finished"`.

After you rebuild with `npm run build`, restart ChatGPT so it starts the new `dist/index.js`.

If the server does not connect, run the command in a terminal. It prints a message and exits when a variable is missing, and it stays silent and waits for input when it started correctly.

A `-32601 Method not found` error at startup means the client called an MCP method the server does not provide. An earlier version exposed only a resource and failed this way on `tools/list`.

### ChatGPT on the web

The web app cannot start a process on your machine. Its custom MCP plugins connect to a remote endpoint, or to a private server through OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The `tunnel-client` runs this server over stdio and connects outbound to OpenAI. Use `tunnel-client init --sample sample_mcp_stdio_local --mcp-command "node /absolute/path/to/mcp-server/git/dist/index.js"` with the accsyn variables exported first. This is only needed for the web app.

## Test in Claude

Claude launches the server as a local stdio process, the same as ChatGPT, so no tunnel or HTTP server is needed. The prerequisites are the same: the accsyn backend running on `127.0.0.1:8181` for a dev test, and `npm run build` so `dist/index.js` exists.

### Claude Desktop

Open the Claude menu in the menu bar, not the settings inside the chat window. Choose Settings, then Developer, then Edit Config. That opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "accsyn": {
      "command": "/path/to/node",
      "args": ["/absolute/path/to/mcp-server/git/dist/index.js"],
      "env": {
        "AS_DEV": "true",
        "ACCSYN_WORKSPACE": "acmefilm",
        "ACCSYN_API_USER": "john@user.com",
        "ACCSYN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Use absolute paths. Desktop apps do not always see the `PATH` of your terminal, so give the full path to `node` (`which node` prints it). Leave `AS_DEV` out to use your real workspace instead of the local backend. If the file already has other servers, add `accsyn` next to them.

Quit Claude Desktop completely and reopen it, because it only reads this file at startup. Then start a new chat and ask: `List all active transfers for john@user.com`, or `List finished transfers for john@user.com`.

If the server does not appear, check the logs. On macOS they are in `~/Library/Logs/Claude`: `mcp.log`, and `mcp-server-accsyn.log` with the server's own error output (for example a missing variable). On Windows they are in `%APPDATA%\Claude\logs`.

### Claude Code

Register the server from a terminal. Everything after `--` is the command that starts the server:

```bash
claude mcp add \
  --env AS_DEV=true \
  --env ACCSYN_WORKSPACE=acmefilm \
  --env ACCSYN_API_USER=john@user.com \
  --env ACCSYN_API_KEY=your-api-key \
  --transport stdio \
  accsyn -- node /absolute/path/to/mcp-server/git/dist/index.js
```

Keep `--transport stdio` after the `--env` options. Claude Code reads a server name that directly follows `--env` as another `KEY=value` pair and rejects it.

Run `claude mcp list` and check that `accsyn` is connected. Use `--scope user` to make it available in all projects. The default stores it for the current project only. The API key ends up in Claude's config file, so do not add the server with `--scope project`, which writes a `.mcp.json` meant to be committed.

Once the package is on npm, replace the command with `npx -y @accsyn/mcp-server`.

## Develop

```bash
npm install
npm test
npm run build
```

`npm run build` writes `dist/`. The package bin is `accsyn-mcp-server`.

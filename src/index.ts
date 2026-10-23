#!/usr/bin/env node
import { Session } from "accsyn";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { credentialsFromEnv } from "./credentials.js";
import {
  DEFAULT_LIMIT,
  listTransfers,
  MAX_LIMIT,
  TRANSFER_STATUSES,
  type TransferList,
  type TransferSession,
  type TransferState,
} from "./transfers.js";

const PARTY_NOTE =
  'A party is "user:<email>" for a remote user, "site:<name>" for a site, or "workspace" for the workspace itself (the main site, HQ). ' +
  'The text after the colon only has to be contained in the name, ignoring case, for example "site:lond". "user:" or "site:" alone matches any party of that type. ' +
  "Text without a type matches a party of any type.";

const DATE_NOTE = "An ISO date or date time such as 2026-10-01 or 2026-10-01T12:00:00Z (a date alone means 00:00 UTC).";

/** Fixed views of the generic listing, offered as resources. Resource URIs cannot carry optional filters. */
interface TransferShortcut {
  resource: string;
  /** Resource URI prefix. The user email follows it. */
  uriPrefix: string;
  state: TransferState;
  title: string;
  description: string;
}

const SHORTCUTS: TransferShortcut[] = [
  {
    resource: "transfer.list",
    uriPrefix: "accsyn://transfer/list/",
    state: "active",
    title: "Active transfers",
    description: "Active accsyn transfers created by one user. Finished and aborted transfers are omitted.",
  },
  {
    resource: "transfer.list_finished",
    uriPrefix: "accsyn://transfer/finished/",
    state: "finished",
    title: "Finished transfers",
    description:
      "Finished accsyn transfers (status done or aborted) created by one user, most recently finished first.",
  },
];

export function createServer(session: TransferSession): McpServer {
  const server = new McpServer({ name: "accsyn", version: "0.1.0" });

  // Clients such as ChatGPT call tools/list when they start, so a tool must exist. All filtering goes through
  // this one tool, so a new filter is a new optional argument and not a new tool.
  server.registerTool(
    "transfer_list",
    {
      title: "List transfers",
      description:
        'List accsyn transfers, optionally filtered. Every argument is optional and the given filters must all match. ' +
        'Examples: "active transfers for john@user.com" is { user: "john@user.com" }; ' +
        '"transfers uploaded to site london by tom@berlinvfx.com" is { source: "user:tom@berlinvfx.com", destination: "site:london" }; ' +
        '"transfers aborted since 12 October" is { state: "finished", status: ["aborted"], finished_after: "2026-10-12" }. ' +
        "Results are most recent first and limited to `limit`; `total` and `truncated` tell if more matched.",
      inputSchema: {
        user: z
          .string()
          .optional()
          .describe(
            "Email address of the user who created the transfers, for example john@user.com. To filter by who sent or received the files, use source or destination instead.",
          ),
        state: z
          .enum(["active", "finished", "all"])
          .optional()
          .describe("active (default): not finished yet. finished: status done or aborted. all: both."),
        status: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(`Only transfers with one of these statuses, for example ["running","paused"]. Known statuses: ${TRANSFER_STATUSES.join(", ")}.`),
        source: z.string().optional().describe(`The sending party. Use it for "downloaded from X" and for "uploaded by X". ${PARTY_NOTE}`),
        destination: z.string().optional().describe(`The receiving party. Use it for "uploaded to X" and for "downloaded by X". ${PARTY_NOTE}`),
        created_after: z.string().optional().describe(`Only transfers created after this time. ${DATE_NOTE}`),
        created_before: z.string().optional().describe(`Only transfers created before this time. ${DATE_NOTE}`),
        finished_after: z.string().optional().describe(`Only transfers finished after this time. ${DATE_NOTE}`),
        finished_before: z.string().optional().describe(`Only transfers finished before this time. ${DATE_NOTE}`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum number of transfers to return. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const list = await listTransfers(session, {
          user: args.user,
          state: args.state,
          status: args.status,
          source: args.source,
          destination: args.destination,
          createdAfter: args.created_after,
          createdBefore: args.created_before,
          finishedAfter: args.finished_after,
          finishedBefore: args.finished_before,
          limit: args.limit,
        });
        return { content: [{ type: "text", text: toJson(list) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );

  for (const shortcut of SHORTCUTS) {
    server.registerResource(
      shortcut.resource,
      new ResourceTemplate(`${shortcut.uriPrefix}{user}`, { list: undefined }),
      {
        title: shortcut.title,
        description: `${shortcut.description} Read ${shortcut.uriPrefix}john@user.com. Use the transfer_list tool for other filters.`,
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const user = decodeURIComponent(single(variables.user));
        const list = await listTransfers(session, { user, state: shortcut.state });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: toJson(list) }] };
      },
    );
  }
  return server;
}

function toJson(list: TransferList): string {
  return JSON.stringify(list, null, 2);
}

function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

async function main(): Promise<void> {
  const credentials = credentialsFromEnv();
  const session = await Session.connect({
    ...credentials,
    pathEnvfile: "/no/such/accsyn.env",
  });
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

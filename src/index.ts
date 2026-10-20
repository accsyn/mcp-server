#!/usr/bin/env node
import { Session } from "accsyn";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { credentialsFromEnv } from "./credentials.js";
import { listActiveTransfers, listFinishedTransfers, type TransferList, type TransferSession } from "./transfers.js";

interface TransferListing {
  /** Tool name. Letters, digits, underscore, and dash only. */
  tool: string;
  /** Resource name. */
  resource: string;
  /** Resource URI prefix. The user email follows it. */
  uriPrefix: string;
  title: string;
  description: string;
  list: (session: TransferSession, user: string) => Promise<TransferList>;
}

const USER_NOTE = "The user is an email address.";

const LISTINGS: TransferListing[] = [
  {
    tool: "transfer_list",
    resource: "transfer.list",
    uriPrefix: "accsyn://transfer/list/",
    title: "Active transfers",
    description: `Active accsyn transfers for one user, for example "list all active transfers for john@user.com". ${USER_NOTE} Finished and aborted transfers are omitted.`,
    list: listActiveTransfers,
  },
  {
    tool: "transfer_list_finished",
    resource: "transfer.list_finished",
    uriPrefix: "accsyn://transfer/finished/",
    title: "Finished transfers",
    description: `Finished accsyn transfers (status done or aborted) for one user, most recent first, for example "list finished transfers for john@user.com". ${USER_NOTE} Active transfers are omitted.`,
    list: listFinishedTransfers,
  },
];

export function createServer(session: TransferSession): McpServer {
  const server = new McpServer({ name: "accsyn", version: "0.1.0" });

  // Each listing is offered as a tool and as a resource. Clients such as ChatGPT call tools/list
  // when they start, so tools must exist, and resources stay available for clients that read them.
  for (const listing of LISTINGS) {
    server.registerTool(
      listing.tool,
      {
        title: listing.title,
        description: listing.description,
        inputSchema: {
          user: z.string().describe("Email address of the user who owns the transfers, for example john@user.com"),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ user }) => {
        try {
          const list = await listing.list(session, user);
          return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    );

    server.registerResource(
      listing.resource,
      new ResourceTemplate(`${listing.uriPrefix}{user}`, { list: undefined }),
      {
        title: listing.title,
        description: `${listing.description} Read ${listing.uriPrefix}john@user.com.`,
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const user = decodeURIComponent(single(variables.user));
        const list = await listing.list(session, user);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(list, null, 2),
            },
          ],
        };
      },
    );
  }
  return server;
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

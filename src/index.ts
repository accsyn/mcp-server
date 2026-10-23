#!/usr/bin/env node
import { Session } from "accsyn";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { credentialsFromEnv } from "./credentials.js";
import {
  DEFAULT_LOG_LIMIT,
  listLogs,
  LOG_SCOPES,
  MAX_LOG_LIMIT,
} from "./logs.js";
import {
  DEFAULT_PROCESS_LIMIT,
  listProcessLog,
  MAX_PROCESS_LIMIT,
  PROCESS_KINDS,
} from "./processlogs.js";
import type { AccsynSession } from "./session.js";
import {
  DEFAULT_LIMIT,
  listTransfers,
  MAX_LIMIT,
  TRANSFER_STATUSES,
  type TransferList,
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

export function createServer(session: AccsynSession): McpServer {
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

  server.registerTool(
    "log_list",
    {
      title: "Read logs",
      description:
        "Read accsyn logs, newest rows first, one page at a time. " +
        'Without job or job_id this reads a general log chosen by scope: "workspace" is the log of the whole workspace, ' +
        '"job" is the general log of all jobs, and "user" is the general log of user events. ' +
        "With job (a job name) or job_id this reads the log of that one job. A job can be a transfer, a delivery or a compute job. " +
        "Examples: \"the logs for job myupload\" is { job: \"myupload\" }; " +
        '"errors in the workspace log" is { search: "error" }. ' +
        "The result has total, pages and has_more. When has_more is true, call again with page set to next_page to read older rows.",
      inputSchema: {
        scope: z
          .enum(LOG_SCOPES)
          .optional()
          .describe('The general log to read: "workspace" (default), "job" or "user". Not used when job or job_id is given.'),
        job: z
          .string()
          .optional()
          .describe(
            "Name of the job to read the log of, for example myupload. The name must match exactly, ignoring case. If several jobs have the name, the most recent is read and a warning lists the others.",
          ),
        job_id: z
          .string()
          .optional()
          .describe("ID of the job to read the log of. Use it instead of job when the ID is known, for example from transfer_list or from a warning about duplicate names."),
        search: z.string().optional().describe("Only rows that contain this text, ignoring case."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_LIMIT)
          .optional()
          .describe(`Rows per page. Default ${DEFAULT_LOG_LIMIT}, at most ${MAX_LOG_LIMIT}.`),
        page: z.number().int().min(1).optional().describe("Page number from 1. Page 1 holds the newest rows."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const list = await listLogs(session, {
          scope: args.scope,
          job: args.job,
          jobId: args.job_id,
          search: args.search,
          limit: args.limit,
          page: args.page,
        });
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );

  server.registerTool(
    "process_log",
    {
      title: "Read process log",
      description:
        "Read the process log (console output) of a job task, for example the detailed transfer log of a transfer. " +
        "The job is given by job (its name) or job_id. A job can be a transfer, a delivery or a compute job. " +
        'By default the master log is read, which is the log of the remote transfer client or the render server. Set process to "slave" for the ' +
        'slave log (the file server party, only available to operators and for transfer jobs), or to "both" to read both, for example to compare them. ' +
        'Set task to the URI of the task. Transfer tasks are numbered from 0, so "task 0" and "the first task" are task "0", and "task 3" is "3". ' +
        "Compute jobs have task URIs that are any text, which is passed on as it is. Without task, the first task that has been processed is read, and the result says which. " +
        "A wrong task is answered with the tasks of the job. " +
        "Output is returned one page of lines at a time, starting with the end of the log, so page 1 holds the newest lines. " +
        "The result has total_lines, pages and has_more. When has_more is true, call again with page set to next_page to read earlier lines. " +
        "Use search to read only lines that contain some text, for example error.",
      inputSchema: {
        job: z.string().optional().describe("Name of the job, for example myupload. Must match exactly, ignoring case. If several jobs have the name, the most recent is read and a warning lists the others."),
        job_id: z.string().optional().describe("ID of the job. Use it instead of job when the ID is known, for example from transfer_list."),
        task: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('URI of the task. For transfers a number from 0, such as "0" for the first task. For compute jobs any text. Left out, the first processed task is read.'),
        try_num: z.number().int().min(0).optional().describe("Which try (attempt) to read, counted from 0. Default is the latest. The result has try_count."),
        process: z
          .enum(PROCESS_KINDS)
          .optional()
          .describe('"master" (default), "slave" or "both". The slave log can only be read by operators, for transfer jobs.'),
        search: z.string().optional().describe("Only lines that contain this text, ignoring case. Each line then starts with its line number."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PROCESS_LIMIT)
          .optional()
          .describe(`Lines per page. Default ${DEFAULT_PROCESS_LIMIT}, at most ${MAX_PROCESS_LIMIT}.`),
        page: z.number().int().min(1).optional().describe("Page number from 1. Page 1 holds the end of the log, the newest lines."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const list = await listProcessLog(session, {
          job: args.job,
          jobId: args.job_id,
          task: args.task,
          tryNum: args.try_num,
          process: args.process,
          search: args.search,
          limit: args.limit,
          page: args.page,
        });
        return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
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

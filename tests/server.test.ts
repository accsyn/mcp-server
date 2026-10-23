import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index";
import { TRANSFER_TYPE, type TransferList, type TransferRecord, type TransferSession } from "../src/transfers";

/** Records every query. Live searches return `live`, finished searches return `finished`. */
function fakeSession(live: TransferRecord[], finished: TransferRecord[]): TransferSession & { queries: string[] } {
  const fake: TransferSession & { queries: string[] } = {
    queries: [],
    async find(query, options) {
      fake.queries.push(query);
      return options?.finished ? finished : live;
    },
  };
  return fake;
}

const live = [
  { id: "a", code: "T1", type: TRANSFER_TYPE, status: "running", created: "2026-10-20T10:00:00Z" },
  { id: "b", code: "T2", type: TRANSFER_TYPE, status: "paused", created: "2026-10-21T10:00:00Z" },
];
const finished = [
  { id: "c", code: "T3", type: TRANSFER_TYPE, status: "done", created: "2026-10-01T10:00:00Z", finished: "2026-10-01T11:00:00Z" },
  { id: "d", code: "T4", type: TRANSFER_TYPE, status: "aborted", created: "2026-10-10T10:00:00Z", finished: "2026-10-10T11:00:00Z" },
];

async function connect(rows = { live, finished }) {
  const session = fakeSession(rows.live, rows.finished);
  const server = createServer(session);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, session };
}

async function callList(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "transfer_list", arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0].text };
}

describe("MCP server startup", () => {
  it("answers the methods a client calls after initialize", async () => {
    const { client } = await connect();
    await expect(client.listTools()).resolves.toBeDefined();
    await expect(client.listResources()).resolves.toBeDefined();
    await expect(client.listResourceTemplates()).resolves.toBeDefined();
  });
});

describe("transfer_list tool", () => {
  it("is the only tool and takes every filter as an optional argument", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["transfer_list"]);
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "created_after",
        "created_before",
        "destination",
        "finished_after",
        "finished_before",
        "limit",
        "source",
        "state",
        "status",
        "user",
      ],
    );
    expect(schema.required ?? []).toEqual([]);
  });

  it("lists active transfers with no arguments", async () => {
    const { client } = await connect();
    const { result, text } = await callList(client, {});
    expect(result.isError).toBeFalsy();
    const list = JSON.parse(text) as TransferList;
    expect(list.transfers.map((job) => job.code)).toEqual(["T2", "T1"]);
  });

  it("combines filters", async () => {
    const { client, session } = await connect();
    const { text } = await callList(client, {
      user: "john@user.com",
      state: "finished",
      status: ["aborted"],
      finished_after: "2026-10-05",
    });
    const list = JSON.parse(text) as TransferList;
    expect(session.queries).toEqual(["Transfer WHERE creator='john@user.com' AND status=aborted"]);
    expect(list.transfers.map((job) => job.code)).toEqual(["T4"]);
  });

  it("finds transfers uploaded to a site by a user", async () => {
    const upload = {
      id: "u1",
      code: "UP",
      type: TRANSFER_TYPE,
      status: "running",
      source_hr: "user:tom@berlinvfx.com[standard](1)",
      destination_hr: "site:london(2)",
    };
    const { client } = await connect({ live: [...live, upload], finished });
    const { text } = await callList(client, { source: "user:tom@berlinvfx.com", destination: "site:london" });
    const list = JSON.parse(text) as TransferList;
    expect(list.transfers.map((job) => job.code)).toEqual(["UP"]);
  });

  it("lists everything for state all", async () => {
    const { client } = await connect();
    const { text } = await callList(client, { state: "all", limit: 3 });
    const list = JSON.parse(text) as TransferList;
    expect(list).toMatchObject({ count: 3, total: 4, truncated: true });
  });

  it("reports an invalid filter as a tool error", async () => {
    const { client } = await connect();
    expect((await callList(client, { user: "john' OR 1" })).result.isError).toBe(true);
    expect((await callList(client, { created_after: "last week" })).result.isError).toBe(true);
  });
});

describe("transfer resources", () => {
  it("lists active transfers for a user", async () => {
    const { client, session } = await connect();
    const read = await client.readResource({ uri: "accsyn://transfer/list/john@user.com" });
    const list = JSON.parse((read.contents[0] as { text: string }).text) as TransferList;
    expect(session.queries).toEqual(["Transfer WHERE creator='john@user.com'"]);
    expect(list.count).toBe(2);
  });

  it("lists finished transfers for a user", async () => {
    const { client } = await connect();
    const read = await client.readResource({ uri: "accsyn://transfer/finished/john@user.com" });
    const list = JSON.parse((read.contents[0] as { text: string }).text) as TransferList;
    expect(list.transfers.map((job) => job.code)).toEqual(["T4", "T3"]);
  });

  it("are listed as resource templates", async () => {
    const { client } = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.name).sort()).toEqual(["transfer.list", "transfer.list_finished"]);
  });
});

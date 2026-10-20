import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index";
import { TRANSFER_TYPE, type TransferRecord, type TransferSession } from "../src/transfers";

function fakeSession(rows: TransferRecord[]): TransferSession {
  return {
    async find() {
      return rows;
    },
  };
}

async function connect(rows: TransferRecord[] = []) {
  const server = createServer(fakeSession(rows));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server startup", () => {
  it("answers the methods a client calls after initialize", async () => {
    const client = await connect();
    await expect(client.listTools()).resolves.toBeDefined();
    await expect(client.listResources()).resolves.toBeDefined();
    await expect(client.listResourceTemplates()).resolves.toBeDefined();
  });
});

describe("transfer list", () => {
  const rows = [
    { id: "a", code: "T1", type: TRANSFER_TYPE, status: "running" },
    { id: "b", code: "T2", type: TRANSFER_TYPE, status: "done" },
  ];

  it("is available as a tool", async () => {
    const client = await connect(rows);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["transfer_list", "transfer_list_finished"]);

    const result = await client.callTool({ name: "transfer_list", arguments: { user: "john@user.com" } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const list = JSON.parse(content[0].text) as { count: number; transfers: TransferRecord[] };
    expect(list.count).toBe(1);
    expect(list.transfers[0].code).toBe("T1");
  });

  it("reports an invalid user as a tool error", async () => {
    const client = await connect(rows);
    const result = await client.callTool({ name: "transfer_list", arguments: { user: "john' OR 1" } });
    expect(result.isError).toBe(true);
  });

  it("is available as a resource", async () => {
    const client = await connect(rows);
    const read = await client.readResource({ uri: "accsyn://transfer/list/john@user.com" });
    const text = (read.contents[0] as { text: string }).text;
    expect(JSON.parse(text).count).toBe(1);
  });
});

describe("finished transfer list", () => {
  const rows = [
    { id: "a", code: "T1", type: TRANSFER_TYPE, status: "running" },
    { id: "b", code: "T2", type: TRANSFER_TYPE, status: "done" },
    { id: "c", code: "T3", type: TRANSFER_TYPE, status: "aborted" },
  ];

  it("is available as a tool", async () => {
    const client = await connect(rows);
    const result = await client.callTool({ name: "transfer_list_finished", arguments: { user: "john@user.com" } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const list = JSON.parse(content[0].text) as { count: number; transfers: TransferRecord[] };
    expect(list.transfers.map((job) => job.code)).toEqual(["T2", "T3"]);
  });

  it("is available as a resource", async () => {
    const client = await connect(rows);
    const read = await client.readResource({ uri: "accsyn://transfer/finished/john@user.com" });
    const text = (read.contents[0] as { text: string }).text;
    expect(JSON.parse(text).count).toBe(2);
  });

  it("is listed as a resource template next to the active listing", async () => {
    const client = await connect(rows);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.name).sort()).toEqual(["transfer.list", "transfer.list_finished"]);
  });
});

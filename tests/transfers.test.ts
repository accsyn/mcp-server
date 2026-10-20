import { describe, expect, it } from "vitest";
import { credentialsFromEnv } from "../src/credentials";
import {
  listActiveTransfers,
  listFinishedTransfers,
  TRANSFER_TYPE,
  type FindTransfersOptions,
  type TransferRecord,
  type TransferSession,
} from "../src/transfers";

function session(rows: TransferRecord[]): TransferSession & { query?: string; options?: FindTransfersOptions } {
  const fake: TransferSession & { query?: string; options?: FindTransfersOptions } = {
    async find(query, options) {
      fake.query = query;
      fake.options = options;
      return rows;
    },
  };
  return fake;
}

describe("listActiveTransfers", () => {
  it("returns active transfers for a user and skips other job types", async () => {
    const api = session([
      { id: "a", code: "T1", type: TRANSFER_TYPE, status: "running", user: "john@user.com" },
      { id: "b", code: "D1", type: 2, status: "waiting" },
      { id: "c", code: "T2", type: TRANSFER_TYPE, status: "done" },
      { id: "d", code: "T3", type: "transfer", status: "paused" },
    ]);
    const list = await listActiveTransfers(api, " john@user.com ");
    expect(api.query).toBe("Transfer WHERE creator='john@user.com'");
    expect(list.count).toBe(2);
    expect(list.transfers.map((job) => job.code)).toEqual(["T1", "T3"]);
    expect(api.options?.finished).toBeUndefined();
  });

  it("returns an empty list when the query finds nothing", async () => {
    const list = await listActiveTransfers(session([]), "john@user.com");
    expect(list).toEqual({ user: "john@user.com", count: 0, transfers: [] });
  });

  it("rejects a user value that cannot be placed in a query", async () => {
    await expect(listActiveTransfers(session([]), "john@user.com' OR code=x")).rejects.toThrow(/email/);
  });
});

describe("listFinishedTransfers", () => {
  it("searches finished jobs and keeps only done and aborted transfers", async () => {
    const api = session([
      { id: "a", code: "T1", type: TRANSFER_TYPE, status: "done" },
      { id: "b", code: "T2", type: TRANSFER_TYPE, status: "aborted" },
      { id: "c", code: "T3", type: TRANSFER_TYPE, status: "running" },
      { id: "d", code: "D1", type: 2, status: "done" },
    ]);
    const list = await listFinishedTransfers(api, "john@user.com");
    expect(api.query).toBe("Transfer WHERE creator='john@user.com'");
    expect(api.options?.finished).toBe(true);
    expect(list.count).toBe(2);
    expect(list.transfers.map((job) => job.code)).toEqual(["T1", "T2"]);
  });

  it("rejects a user value that cannot be placed in a query", async () => {
    await expect(listFinishedTransfers(session([]), "x' OR code=y")).rejects.toThrow(/email/);
  });
});

describe("credentialsFromEnv", () => {
  it("requires workspace, user, and API key", () => {
    expect(() => credentialsFromEnv({ ACCSYN_API_KEY: "secret" })).toThrow(/ACCSYN_WORKSPACE, ACCSYN_API_USER/);
    expect(
      credentialsFromEnv({
        ACCSYN_WORKSPACE: "acmefilm",
        ACCSYN_API_USER: "john@user.com",
        ACCSYN_API_KEY: "secret",
      }),
    ).toEqual({
      workspace: "acmefilm",
      username: "john@user.com",
      apiKey: "secret",
    });
  });
});

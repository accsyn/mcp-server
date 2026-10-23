import { describe, expect, it } from "vitest";
import { credentialsFromEnv } from "../src/credentials";
import {
  listTransfers,
  TRANSFER_TYPE,
  type FindTransfersOptions,
  type TransferRecord,
  type TransferSession,
} from "../src/transfers";

interface Call {
  query: string;
  options?: FindTransfersOptions;
}

/** A fake session. Live searches return `live`, finished searches return `finished`. */
function session(live: TransferRecord[], finished: TransferRecord[] = []): TransferSession & { calls: Call[] } {
  const fake: TransferSession & { calls: Call[] } = {
    calls: [],
    async find(query, options) {
      fake.calls.push({ query, options });
      return options?.finished ? finished : live;
    },
  };
  return fake;
}

const t = (code: string, status: string, extra: Record<string, unknown> = {}): TransferRecord => ({
  id: code,
  code,
  type: TRANSFER_TYPE,
  status,
  ...extra,
});

describe("listTransfers: scope", () => {
  it("defaults to active transfers of any user", async () => {
    const api = session([t("T1", "running"), t("T2", "done"), t("T3", "paused")]);
    const list = await listTransfers(api);
    expect(api.calls).toEqual([{ query: "Transfer", options: expect.objectContaining({}) }]);
    expect(api.calls[0].options?.finished).toBeUndefined();
    expect(list.transfers.map((job) => job.code).sort()).toEqual(["T1", "T3"]);
    expect(list).toMatchObject({ count: 2, total: 2, truncated: false });
  });

  it("filters by user in the backend query", async () => {
    const api = session([t("T1", "running")]);
    await listTransfers(api, { user: " john@user.com " });
    expect(api.calls[0].query).toBe("Transfer WHERE creator='john@user.com'");
  });

  it("searches finished jobs and keeps only done and aborted", async () => {
    const api = session([], [t("T1", "done"), t("T2", "aborted"), t("T3", "running")]);
    const list = await listTransfers(api, { state: "finished" });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].options?.finished).toBe(true);
    expect(list.transfers.map((job) => job.code).sort()).toEqual(["T1", "T2"]);
  });

  it("searches both live and finished jobs for state all", async () => {
    const api = session([t("T1", "running")], [t("T2", "done")]);
    const list = await listTransfers(api, { state: "all" });
    expect(api.calls.map((call) => Boolean(call.options?.finished))).toEqual([false, true]);
    expect(list.total).toBe(2);
  });

  it("does not list a transfer twice", async () => {
    const api = session([t("T1", "running")], [t("T1", "done")]);
    const list = await listTransfers(api, { state: "all" });
    expect(list.transfers).toHaveLength(1);
    expect(list.total).toBe(1);
  });

  it("returns an empty list when nothing is found", async () => {
    const list = await listTransfers(session([]), { user: "john@user.com" });
    expect(list).toMatchObject({ count: 0, total: 0, truncated: false, transfers: [] });
  });
});

describe("listTransfers: status", () => {
  it("uses = for one status", async () => {
    const api = session([t("T1", "running")]);
    await listTransfers(api, { status: ["Running"] });
    expect(api.calls[0].query).toBe("Transfer WHERE status=running");
  });

  it("uses in for several statuses and combines with user using AND", async () => {
    const api = session([t("T1", "running")]);
    await listTransfers(api, { user: "john@user.com", status: ["running", "paused", "running"] });
    expect(api.calls[0].query).toBe("Transfer WHERE creator='john@user.com' AND status in running,paused");
  });

  it("accepts a comma separated string", async () => {
    const api = session([]);
    await listTransfers(api, { status: "running, paused" });
    expect(api.calls[0].query).toBe("Transfer WHERE status in running,paused");
  });

  it("rejects a status that cannot be placed in a query", async () => {
    await expect(listTransfers(session([]), { status: ["running OR 1=1"] })).rejects.toThrow(/Invalid status/);
  });
});

describe("listTransfers: source and destination", () => {
  const rows = [
    // The human readable forms start with the party type and may end with [role](id), as in the API documentation.
    t("UP-LONDON", "running", {
      source_hr: "user:tom@berlinvfx.com[standard](6676f3e9c7ef4e27da254e57)",
      destination_hr: "site:London Office[?](5f0000000000000000000001)",
    }),
    t("UP-PARIS", "running", {
      source_hr: "user:tom@berlinvfx.com",
      destination_hr: "site:paris",
    }),
    t("DOWN-LISA", "running", {
      source_hr: "workspace:seagull(6645fbca9f8c4d3e7a3b678d)",
      destination_hr: "user:lisa@example.com[standard](6676f3e9c7ef4e27da254e58)",
    }),
    t("NO-PARTIES", "running"),
  ];
  const codes = async (filters: Parameters<typeof listTransfers>[1]) =>
    (await listTransfers(session(rows), filters)).transfers.map((job) => job.code).sort();

  it("finds transfers uploaded to a site by a user", async () => {
    expect(await codes({ source: "user:tom@berlinvfx.com", destination: "site:london" })).toEqual(["UP-LONDON"]);
  });

  it("matches the party name by containment, ignoring case", async () => {
    expect(await codes({ destination: "site:LOND" })).toEqual(["UP-LONDON"]);
    expect(await codes({ source: "user:berlinvfx" })).toEqual(["UP-LONDON", "UP-PARIS"]);
  });

  it("does not match the role or id in the human readable form", async () => {
    expect(await codes({ source: "user:standard" })).toEqual([]);
    expect(await codes({ source: "user:6676f3e9" })).toEqual([]);
  });

  it("matches any party of a type", async () => {
    expect(await codes({ destination: "site:" })).toEqual(["UP-LONDON", "UP-PARIS"]);
    expect(await codes({ destination: "user" })).toEqual(["DOWN-LISA"]);
    expect(await codes({ source: "workspace" })).toEqual(["DOWN-LISA"]);
    expect(await codes({ source: "workspace:seagull" })).toEqual(["DOWN-LISA"]);
    expect(await codes({ source: "workspace:other" })).toEqual([]);
  });

  it("matches a name of any type when no type is given", async () => {
    expect(await codes({ destination: "paris" })).toEqual(["UP-PARIS"]);
    expect(await codes({ destination: "lisa@example.com" })).toEqual(["DOWN-LISA"]);
  });

  it("requires the type to match", async () => {
    expect(await codes({ destination: "user:london" })).toEqual([]);
  });

  it("rejects an empty party", async () => {
    await expect(listTransfers(session([]), { source: "  " })).rejects.toThrow(/source/);
  });
});

describe("listTransfers: dates", () => {
  const rows = [
    t("OLD", "done", { created: "2026-09-01T10:00:00Z", finished: "2026-09-01T11:00:00Z" }),
    t("MID", "done", { created: new Date("2026-10-05T10:00:00Z"), finished: new Date("2026-10-05T11:00:00Z") }),
    t("NEW", "aborted", { created: "2026-10-20T10:00:00Z", finished: "2026-10-20T10:30:00Z" }),
    t("NODATE", "done"),
  ];

  it("filters on created", async () => {
    const api = session([], rows);
    const list = await listTransfers(api, { state: "finished", createdAfter: "2026-10-01", createdBefore: "2026-10-10" });
    expect(list.transfers.map((job) => job.code)).toEqual(["MID"]);
  });

  it("filters on finished and combines with status", async () => {
    const api = session([], rows);
    const list = await listTransfers(api, { state: "finished", status: "aborted", finishedAfter: "2026-10-12" });
    expect(list.transfers.map((job) => job.code)).toEqual(["NEW"]);
    expect(api.calls[0].query).toBe("Transfer WHERE status=aborted");
  });

  it("lists finished transfers by finish time, newest first", async () => {
    const list = await listTransfers(session([], rows), { state: "finished" });
    expect(list.transfers.map((job) => job.code)).toEqual(["NEW", "MID", "OLD", "NODATE"]);
  });

  it("rejects a date that cannot be read", async () => {
    await expect(listTransfers(session([]), { createdAfter: "last week" })).rejects.toThrow(/created_after/);
  });
});

describe("listTransfers: limit and validation", () => {
  it("applies the limit and reports that more matched", async () => {
    const rows = [1, 2, 3].map((n) => t(`T${n}`, "running", { created: `2026-10-0${n}T10:00:00Z` }));
    const list = await listTransfers(session(rows), { limit: 2 });
    expect(list).toMatchObject({ count: 2, total: 3, truncated: true });
    expect(list.transfers.map((job) => job.code)).toEqual(["T3", "T2"]);
  });

  it("rejects a limit that is out of range", async () => {
    await expect(listTransfers(session([]), { limit: 0 })).rejects.toThrow(/limit/);
    await expect(listTransfers(session([]), { limit: 1000 })).rejects.toThrow(/limit/);
  });

  it("rejects a user value that cannot be placed in a query", async () => {
    await expect(listTransfers(session([]), { user: "john@user.com' OR code=x" })).rejects.toThrow(/email/);
    await expect(listTransfers(session([]), { user: "  " })).rejects.toThrow(/email/);
  });

  it("rejects an unknown state", async () => {
    await expect(listTransfers(session([]), { state: "bogus" as never })).rejects.toThrow(/state/);
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

import { describe, expect, it } from "vitest";
import { listLogs, MAX_TEXT_LENGTH, type LogReader, type LogRequest } from "../src/logs";
import type { FindTransfersOptions, TransferRecord } from "../src/transfers";

/** Row n of a log of `size` rows, as the backend returns them: oldest first, no index until windowed. */
function makeRows(size: number, text = (n: number) => `line ${n}`): Array<Record<string, unknown>> {
  return Array.from({ length: size }, (_, i) => ({
    id: `row${i + 1}`,
    date: `2026-03-03T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    title: "Process",
    text: text(i + 1),
    ref: "69a6ac82f257470b44905a26",
    ref_hr: "Upload to X",
    user: null,
    ip: null,
    device: null,
  }));
}

interface Fake extends LogReader {
  logCalls: LogRequest[];
  findCalls: Array<{ query: string; options?: FindTransfersOptions }>;
}

/**
 * Behaves like the backend `disklog_find`: oldest first, `index` counted from 1, `total` counted after `search`,
 * and `start: -1` with `size` giving the last `size` rows. With `windowed` false it ignores the window and returns
 * every row, as an older accsyn API that drops `paginationStart` and `paginationSize` would.
 */
function session(
  logRows: Array<Record<string, unknown>>,
  jobs: { live?: TransferRecord[]; finished?: TransferRecord[] } = {},
  windowed = true,
): Fake {
  const fake: Fake = {
    logCalls: [],
    findCalls: [],
    async logs(options = {}) {
      fake.logCalls.push(options);
      const matching = options.search
        ? logRows.filter((row) => JSON.stringify(row).toLowerCase().includes(options.search!.toLowerCase()))
        : logRows;
      const total = matching.length;
      const indexed = matching.map((row, i) => ({ ...row, index: i + 1 }));
      const size = options.paginationSize;
      const result = windowed && options.paginationStart === -1 && size ? indexed.slice(Math.max(0, total - size)) : indexed;
      return { result, pagination: { start: 1, end: total, total } };
    },
    async find(query, options) {
      fake.findCalls.push({ query, options });
      return options?.finished ? (jobs.finished ?? []) : (jobs.live ?? []);
    },
  };
  return fake;
}

const JOB_ID = "69a6ac82f257470b44905a26";
const job = (id: string, code: string, status: string, created: string): TransferRecord => ({ id, code, status, created });

describe("listLogs: general logs", () => {
  it("reads the workspace log and returns the newest rows first", async () => {
    const api = session(makeRows(252));
    const list = await listLogs(api);
    expect(api.logCalls).toEqual([{ entityType: "workspace", paginationStart: -1, paginationSize: 50 }]);
    expect(list).toMatchObject({ scope: "workspace", page: 1, limit: 50, pages: 6, count: 50, total: 252, has_more: true, next_page: 2 });
    expect(list.entries[0]).toMatchObject({ index: 252, text: "line 252" });
    expect(list.entries[49]).toMatchObject({ index: 203 });
  });

  it("reads the job and user logs", async () => {
    const api = session(makeRows(3));
    await listLogs(api, { scope: "job" });
    await listLogs(api, { scope: "user" });
    expect(api.logCalls.map((call) => call.entityType)).toEqual(["job", "user"]);
    expect(api.logCalls.every((call) => call.entityId === undefined)).toBe(true);
  });

  it("reads older pages by asking for the newest page * limit rows and cutting the page out", async () => {
    const api = session(makeRows(252));
    const list = await listLogs(api, { page: 3, limit: 50 });
    expect(api.logCalls[0]).toMatchObject({ paginationStart: -1, paginationSize: 150 });
    expect(list.entries.map((entry) => entry.index)).toEqual(Array.from({ length: 50 }, (_, i) => 152 - i));
    expect(list).toMatchObject({ page: 3, count: 50, has_more: true, next_page: 4 });
  });

  it("returns a short last page without more pages", async () => {
    const list = await listLogs(session(makeRows(252)), { page: 6 });
    expect(list.entries.map((entry) => entry.index)).toEqual([2, 1]);
    expect(list).toMatchObject({ count: 2, pages: 6, has_more: false });
    expect(list.next_page).toBeUndefined();
  });

  it("gives the same page when the API ignores the window and returns every row", async () => {
    const windowed = await listLogs(session(makeRows(252)), { page: 2, limit: 20 });
    const whole = await listLogs(session(makeRows(252), {}, false), { page: 2, limit: 20 });
    expect(whole).toEqual(windowed);
  });

  it("warns when the page is past the end", async () => {
    const list = await listLogs(session(makeRows(10)), { page: 4, limit: 5 });
    expect(list.entries).toEqual([]);
    expect(list.warning).toMatch(/past the last page/);
    expect(list.pages).toBe(2);
  });

  it("handles an empty log", async () => {
    const list = await listLogs(session([]));
    expect(list).toMatchObject({ count: 0, total: 0, pages: 1, has_more: false, entries: [] });
    expect(list.warning).toBeUndefined();
  });

  it("passes search on and counts only matching rows", async () => {
    const api = session(makeRows(100, (n) => (n % 10 === 0 ? `ERROR on ${n}` : `line ${n}`)));
    const list = await listLogs(api, { search: " error ", limit: 4 });
    expect(api.logCalls[0].search).toBe("error");
    expect(list).toMatchObject({ search: "error", total: 10, pages: 3, count: 4 });
    // The index counts the rows that matched the search, like the total does.
    expect(list.entries.map((entry) => entry.index)).toEqual([10, 9, 8, 7]);
    expect(list.entries.map((entry) => entry.text)).toEqual(["ERROR on 100", "ERROR on 90", "ERROR on 80", "ERROR on 70"]);
  });

  it("omits empty fields and cuts long texts", async () => {
    const list = await listLogs(session(makeRows(1, () => "x".repeat(MAX_TEXT_LENGTH + 500))));
    const entry = list.entries[0];
    expect(entry).not.toHaveProperty("ip");
    expect(entry).not.toHaveProperty("user");
    expect(entry.ref_hr).toBe("Upload to X");
    expect(entry.text).toMatch(/\.\.\. \[500 more characters\]$/);
    expect(entry.text?.length).toBeLessThan(MAX_TEXT_LENGTH + 50);
  });
});

describe("listLogs: one job", () => {
  it("looks the job up by name and reads its log by ID", async () => {
    const api = session(makeRows(5), { live: [job(JOB_ID, "myupload", "running", "2026-10-20T10:00:00Z")] });
    const list = await listLogs(api, { job: "myupload" });
    expect(api.findCalls.map((call) => call.query)).toEqual(["Job WHERE code='myupload'", "Job WHERE code='myupload'"]);
    expect(api.findCalls.map((call) => Boolean(call.options?.finished))).toEqual([false, true]);
    expect(api.logCalls[0]).toMatchObject({ entityType: "job", entityId: JOB_ID });
    expect(list).toMatchObject({ scope: "job", job: { id: JOB_ID, code: "myupload", status: "running" }, total: 5 });
    expect(list.warning).toBeUndefined();
  });

  it("finds finished jobs too", async () => {
    const api = session(makeRows(2), { finished: [job(JOB_ID, "old", "done", "2026-09-01T10:00:00Z")] });
    const list = await listLogs(api, { job: "old" });
    expect(list.job?.id).toBe(JOB_ID);
  });

  it("matches the name exactly, ignoring case", async () => {
    const api = session(makeRows(2), {
      live: [job(JOB_ID, "MyUpload", "running", "2026-10-20T10:00:00Z"), job("b".repeat(24), "myupload2", "running", "2026-10-21T10:00:00Z")],
    });
    const list = await listLogs(api, { job: "myupload" });
    expect(list.job?.id).toBe(JOB_ID);
    expect(list.warning).toBeUndefined();
  });

  it("warns when several jobs have the name and uses the most recent", async () => {
    const older = "a".repeat(24);
    const newer = "c".repeat(24);
    const api = session(makeRows(2), {
      live: [job(newer, "myupload", "running", "2026-10-22T10:00:00Z")],
      finished: [job(older, "myupload", "done", "2026-09-01T10:00:00Z")],
    });
    const list = await listLogs(api, { job: "myupload" });
    expect(api.logCalls[0].entityId).toBe(newer);
    expect(list.warning).toContain("2 jobs are named");
    expect(list.warning).toContain(older);
    expect(list.warning).toContain("job_id");
  });

  it("reports an unknown job", async () => {
    await expect(listLogs(session([]), { job: "nope" })).rejects.toThrow(/No job named "nope"/);
  });

  it("reads a job by ID without looking it up", async () => {
    const api = session(makeRows(3));
    const list = await listLogs(api, { jobId: JOB_ID.toUpperCase(), scope: "user" });
    expect(api.findCalls).toEqual([]);
    expect(api.logCalls[0]).toMatchObject({ entityType: "job", entityId: JOB_ID.toUpperCase() });
    expect(list).toMatchObject({ scope: "job", job: { id: JOB_ID.toUpperCase() } });
  });

  it("prefers job_id over job", async () => {
    const api = session(makeRows(1));
    await listLogs(api, { jobId: JOB_ID, job: "myupload" });
    expect(api.findCalls).toEqual([]);
  });
});

describe("listLogs: validation", () => {
  it("rejects values that cannot be used", async () => {
    const api = session(makeRows(1));
    await expect(listLogs(api, { scope: "share" as never })).rejects.toThrow(/scope/);
    await expect(listLogs(api, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(listLogs(api, { limit: 201 })).rejects.toThrow(/limit/);
    await expect(listLogs(api, { page: 0 })).rejects.toThrow(/page/);
    await expect(listLogs(api, { page: 26, limit: 200 })).rejects.toThrow(/search to narrow/);
    await expect(listLogs(api, { jobId: "not-an-id" })).rejects.toThrow(/job_id/);
    await expect(listLogs(api, { job: "x' OR code='y" })).rejects.toThrow(/job name/);
    await expect(listLogs(api, { job: "  " })).rejects.toThrow(/job name/);
    expect(api.logCalls).toEqual([]);
  });
});

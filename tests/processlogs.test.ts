import { describe, expect, it } from "vitest";
import { listProcessLog, MAX_LINE_LENGTH, type ProcessLogReader, type ProcessLogRequest } from "../src/processlogs";
import type { FindTransfersOptions, TransferRecord } from "../src/transfers";

const JOB_ID = "69a6ac82f257470b44905a26";
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

interface Fake extends ProcessLogReader {
  processCalls: Array<{ entityId: string; options?: ProcessLogRequest }>;
  findCalls: Array<{ query: string; options?: FindTransfersOptions }>;
}

/**
 * Behaves like the backend: the master text is returned when `master` is set and the slave text when `slave` is
 * set, an unknown task is an error, and `Task` queries list the tasks of a job.
 */
function session(
  options: {
    master?: string;
    slave?: string;
    tasks?: Record<string, unknown>[];
    jobs?: TransferRecord[];
    response?: Record<string, unknown>;
  } = {},
): Fake {
  const tasks = options.tasks ?? [
    { uri: "0", status: "done" },
    { uri: "1", status: "queued" },
  ];
  const fake: Fake = {
    processCalls: [],
    findCalls: [],
    async processLogs(entityId, request = {}) {
      fake.processCalls.push({ entityId, options: request });
      if (request.uri !== undefined && !tasks.some((task) => task.uri === request.uri)) {
        throw new Error(`Unknown task - '${request.uri}'!`);
      }
      return {
        uri: request.uri ?? "0",
        try: request.tryNum ?? 1,
        try_count: 2,
        ...(request.master && options.master !== undefined ? { text_master: options.master } : {}),
        ...(request.slave && options.slave !== undefined ? { text_slave: options.slave } : {}),
        ...options.response,
      };
    },
    async find(query, findOptions) {
      fake.findCalls.push({ query, options: findOptions });
      if (query === "Task") {
        return tasks as TransferRecord[];
      }
      return findOptions?.finished ? [] : (options.jobs ?? []);
    },
  };
  return fake;
}

describe("listProcessLog: which log", () => {
  const master = lines(5, "master").join("\n");
  const slave = lines(3, "slave").join("\n");

  it("reads the master log by default", async () => {
    const api = session({ master, slave });
    const list = await listProcessLog(api, { jobId: JOB_ID });
    expect(api.processCalls).toEqual([{ entityId: JOB_ID, options: { master: true, slave: false } }]);
    expect(list.master?.text).toBe(master);
    expect(list.slave).toBeUndefined();
    expect(list).toMatchObject({ job: { id: JOB_ID }, task: "0", try: 1, try_count: 2 });
    expect(list.warning).toBeUndefined();
  });

  it("reads the slave log only", async () => {
    const api = session({ master, slave });
    const list = await listProcessLog(api, { jobId: JOB_ID, process: "slave" });
    expect(api.processCalls[0].options).toEqual({ master: false, slave: true });
    expect(list.slave?.text).toBe(slave);
    expect(list.master).toBeUndefined();
  });

  it("reads both logs for comparison", async () => {
    const api = session({ master, slave });
    const list = await listProcessLog(api, { jobId: JOB_ID, process: "both" });
    expect(api.processCalls).toHaveLength(1);
    expect(api.processCalls[0].options).toEqual({ master: true, slave: true });
    expect(list.master?.text).toBe(master);
    expect(list.slave?.text).toBe(slave);
  });

  it("warns when the slave log was not returned", async () => {
    const list = await listProcessLog(session({ master }), { jobId: JOB_ID, process: "both" });
    expect(list.master?.text).toBe(master);
    expect(list.slave).toBeUndefined();
    expect(list.warning).toMatch(/No slave log/);
  });

  it("rejects an unknown process", async () => {
    await expect(listProcessLog(session(), { jobId: JOB_ID, process: "other" as never })).rejects.toThrow(/process/);
  });
});

describe("listProcessLog: which job and task", () => {
  it("needs a job", async () => {
    await expect(listProcessLog(session(), {})).rejects.toThrow(/job_id/);
  });

  it("looks a job up by name", async () => {
    const api = session({
      master: "x",
      jobs: [{ id: JOB_ID, code: "myupload", status: "running", created: "2026-10-20T10:00:00Z" }],
    });
    const list = await listProcessLog(api, { job: "myupload" });
    expect(api.processCalls[0].entityId).toBe(JOB_ID);
    expect(list.job).toMatchObject({ id: JOB_ID, code: "myupload" });
  });

  it("passes on a task number as a string", async () => {
    const api = session({ master: "x" });
    await listProcessLog(api, { jobId: JOB_ID, task: 0 });
    expect(api.processCalls[0].options).toMatchObject({ uri: "0" });
    await listProcessLog(api, { jobId: JOB_ID, task: " 1 " });
    expect(api.processCalls[1].options).toMatchObject({ uri: "1" });
  });

  it("passes on a compute task URI as it is", async () => {
    const api = session({ master: "x", tasks: [{ uri: "render/frame_0042", status: "done" }] });
    const list = await listProcessLog(api, { jobId: JOB_ID, task: "render/frame_0042" });
    expect(api.processCalls[0].options).toMatchObject({ uri: "render/frame_0042" });
    expect(list.task).toBe("render/frame_0042");
  });

  it("lets accsyn choose the task when none is given", async () => {
    const api = session({ master: "x" });
    await listProcessLog(api, { jobId: JOB_ID });
    expect(api.processCalls[0].options).not.toHaveProperty("uri");
  });

  it("passes on the try", async () => {
    const api = session({ master: "x" });
    const list = await listProcessLog(api, { jobId: JOB_ID, tryNum: 0 });
    expect(api.processCalls[0].options).toMatchObject({ tryNum: 0 });
    expect(list.try).toBe(0);
  });

  it("lists the tasks of the job when the task is unknown", async () => {
    const api = session({ master: "x" });
    const result = listProcessLog(api, { jobId: JOB_ID, task: "nope" });
    await expect(result).rejects.toThrow(/Unknown task - 'nope'!.*The tasks of this job are: 0 \(done\), 1 \(queued\)/);
    expect(api.findCalls).toEqual([{ query: "Task", options: { entityId: JOB_ID } }]);
  });

  it("keeps the original error when the tasks cannot be listed", async () => {
    const api = session({ master: "x" });
    api.find = async () => {
      throw new Error("denied");
    };
    await expect(listProcessLog(api, { jobId: JOB_ID, task: "nope" })).rejects.toThrow(/^Unknown task - 'nope'!$/);
  });

  it("does not look for tasks on other errors", async () => {
    const api = session({ master: "x" });
    api.processLogs = async () => {
      throw new Error("Permission denied");
    };
    await expect(listProcessLog(api, { jobId: JOB_ID })).rejects.toThrow(/^Permission denied$/);
    expect(api.findCalls).toEqual([]);
  });

  it("rejects values that cannot be used", async () => {
    const api = session({ master: "x" });
    await expect(listProcessLog(api, { jobId: "nope" })).rejects.toThrow(/job_id/);
    await expect(listProcessLog(api, { jobId: JOB_ID, task: "  " })).rejects.toThrow(/task/);
    await expect(listProcessLog(api, { jobId: JOB_ID, task: 1.5 })).rejects.toThrow(/task/);
    await expect(listProcessLog(api, { jobId: JOB_ID, tryNum: -1 })).rejects.toThrow(/try_num/);
    await expect(listProcessLog(api, { jobId: JOB_ID, limit: 0 })).rejects.toThrow(/limit/);
    await expect(listProcessLog(api, { jobId: JOB_ID, limit: 1001 })).rejects.toThrow(/limit/);
    await expect(listProcessLog(api, { jobId: JOB_ID, page: 0 })).rejects.toThrow(/page/);
    expect(api.processCalls).toEqual([]);
  });
});

describe("listProcessLog: pages of lines", () => {
  const text = `${lines(450).join("\n")}\n`;

  it("returns the end of the log first", async () => {
    const list = await listProcessLog(session({ master: text }), { jobId: JOB_ID, limit: 200 });
    expect(list.master).toMatchObject({ total_lines: 450, page: 1, pages: 3, has_more: true, next_page: 2, first_line: 251 });
    const shown = list.master!.text.split("\n");
    expect(shown).toHaveLength(200);
    expect(shown[0]).toBe("line 251");
    expect(shown[199]).toBe("line 450");
  });

  it("reads earlier lines on the next pages, up to the first line", async () => {
    const api = session({ master: text });
    const second = await listProcessLog(api, { jobId: JOB_ID, limit: 200, page: 2 });
    expect(second.master).toMatchObject({ page: 2, has_more: true, first_line: 51 });
    expect(second.master!.text.split("\n")[0]).toBe("line 51");
    const third = await listProcessLog(api, { jobId: JOB_ID, limit: 200, page: 3 });
    expect(third.master).toMatchObject({ page: 3, pages: 3, has_more: false, first_line: 1 });
    expect(third.master!.text.split("\n")).toHaveLength(50);
    expect(third.master!.next_page).toBeUndefined();
  });

  it("pages both logs on their own", async () => {
    const list = await listProcessLog(session({ master: lines(10).join("\n"), slave: lines(3).join("\n") }), {
      jobId: JOB_ID,
      process: "both",
      limit: 4,
    });
    expect(list.master).toMatchObject({ total_lines: 10, pages: 3, first_line: 7 });
    expect(list.slave).toMatchObject({ total_lines: 3, pages: 1, first_line: 1, has_more: false });
  });

  it("handles carriage returns and an empty log", async () => {
    const list = await listProcessLog(session({ master: "a\r\nb\rc\n" }), { jobId: JOB_ID });
    expect(list.master?.text).toBe("a\nb\nc");
    const empty = await listProcessLog(session({ master: "" }), { jobId: JOB_ID });
    expect(empty.master).toMatchObject({ total_lines: 0, pages: 1, has_more: false, text: "" });
    expect(empty.master).not.toHaveProperty("first_line");
  });

  it("returns an empty page past the end", async () => {
    const list = await listProcessLog(session({ master: lines(5).join("\n") }), { jobId: JOB_ID, limit: 5, page: 4 });
    expect(list.master).toMatchObject({ page: 4, pages: 1, text: "" });
  });

  it("keeps matching lines only, with their line numbers", async () => {
    const log = lines(100).map((line, i) => (i % 25 === 0 ? `ERROR at ${line}` : line));
    const list = await listProcessLog(session({ master: log.join("\n") }), { jobId: JOB_ID, search: " error ", limit: 3 });
    expect(list.search).toBe("error");
    expect(list.master).toMatchObject({ total_lines: 4, pages: 2, numbered: true, has_more: true, next_page: 2 });
    expect(list.master!.text.split("\n")).toEqual(["26: ERROR at line 26", "51: ERROR at line 51", "76: ERROR at line 76"]);
    expect(list.master).not.toHaveProperty("first_line");
  });

  it("cuts very long lines", async () => {
    const list = await listProcessLog(session({ master: "x".repeat(MAX_LINE_LENGTH + 300) }), { jobId: JOB_ID });
    expect(list.master!.text).toMatch(/\.\.\. \[300 more characters\]$/);
  });

  it("passes on the earlier tries", async () => {
    const history = { "0": { pid: "p0", hostname: "host1" } };
    const list = await listProcessLog(session({ master: "x", response: { process_history: history } }), { jobId: JOB_ID });
    expect(list.process_history).toEqual(history);
  });
});

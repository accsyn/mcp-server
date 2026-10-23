import { findJob, parseJobId, type LogJob } from "./logs.js";
import type { TransferSession } from "./transfers.js";

/** Which process log to read: the master (the transfer client or render server), the slave (file server party), or both. */
export const PROCESS_KINDS = ["master", "slave", "both"] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export const DEFAULT_PROCESS_LIMIT = 200;
export const MAX_PROCESS_LIMIT = 1000;
/** Console output can have very long lines, for example progress output. Longer lines are cut. */
export const MAX_LINE_LENGTH = 1000;
const MAX_LISTED_TASKS = 50;

export interface ProcessLogRequest {
  uri?: string;
  tryNum?: number;
  master?: boolean;
  slave?: boolean;
}

export interface ProcessLogSession {
  processLogs(entityId: string, options?: ProcessLogRequest): Promise<Record<string, unknown>>;
}

/** What reading process logs needs from an accsyn `Session`: `processLogs`, and `find` for jobs and tasks. */
export interface ProcessLogReader extends TransferSession, ProcessLogSession {}

export interface ProcessLogFilters {
  /** Name (code) of the job. */
  job?: string;
  /** ID of the job. Wins over `job`. */
  jobId?: string;
  /**
   * URI of the task. Transfer tasks are numbered from "0". Compute jobs have any string, which is passed on as it is.
   * Without it the first task that has been processed is used.
   */
  task?: string | number;
  /** Zero based try (attempt). Default is the latest. */
  tryNum?: number;
  /** Default `master`. */
  process?: ProcessKind;
  /** Only lines that contain this text, ignoring case. */
  search?: string;
  /** Lines per page. Default 200, at most 1000. */
  limit?: number;
  /** Page number from 1. Page 1 holds the end of the log, the newest lines. */
  page?: number;
}

export interface ProcessText {
  /** Lines in the whole log, or the lines that matched `search`. */
  total_lines: number;
  page: number;
  pages: number;
  has_more: boolean;
  /** Pass this as `page` to read the lines before these. */
  next_page?: number;
  /** Number of the first line shown, counted from 1 for the first line of the log. */
  first_line?: number;
  /** True when each line starts with its number in the log and a colon. Only used together with `search`. */
  numbered?: boolean;
  /** The lines of this page, in the order of the log, separated by newlines. */
  text: string;
}

export interface ProcessLogList {
  job: LogJob;
  /** Something the agent should tell the user. */
  warning?: string;
  /** URI of the task the log is from. */
  task?: string;
  /** The try that was read, counted from 0, and the number of tries the task has had. */
  try?: number;
  try_count?: number;
  /** Earlier tries of the task, as reported by accsyn. */
  process_history?: unknown;
  search?: string;
  master?: ProcessText;
  slave?: ProcessText;
}

/**
 * Read the process log (console output) of a job task, one page of lines at a time with the end of the log first.
 * The master log, the slave log, or both can be read, for example to compare them.
 *
 * accsyn returns the whole log on every call, so a page only limits what the agent gets, not what is transferred.
 */
export async function listProcessLog(session: ProcessLogReader, filters: ProcessLogFilters = {}): Promise<ProcessLogList> {
  const process = filters.process ?? "master";
  if (!PROCESS_KINDS.includes(process)) {
    throw new Error(`process must be one of ${PROCESS_KINDS.join(", ")}.`);
  }
  const limit = filters.limit ?? DEFAULT_PROCESS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROCESS_LIMIT) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_PROCESS_LIMIT}.`);
  }
  const page = filters.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("page must be a whole number from 1.");
  }
  if (filters.tryNum !== undefined && (!Number.isInteger(filters.tryNum) || filters.tryNum < 0)) {
    throw new Error("try_num must be a whole number from 0.");
  }
  const task = parseTask(filters.task);
  const search = filters.search?.trim() || undefined;

  let job: LogJob;
  let warning: string | undefined;
  if (filters.jobId !== undefined) {
    job = { id: parseJobId(filters.jobId) };
  } else if (filters.job !== undefined) {
    const found = await findJob(session, filters.job);
    job = found.job;
    warning = found.warning;
  } else {
    throw new Error("Provide job (the name of the job) or job_id.");
  }

  let response: Record<string, unknown>;
  try {
    response = await session.processLogs(job.id, {
      ...(task !== undefined ? { uri: task } : {}),
      ...(filters.tryNum !== undefined ? { tryNum: filters.tryNum } : {}),
      master: process !== "slave",
      slave: process !== "master",
    });
  } catch (error) {
    throw await explainTaskError(session, job.id, error);
  }

  const result: ProcessLogList = { job };
  const warnings: string[] = warning ? [warning] : [];
  if (typeof response.uri === "string") {
    result.task = response.uri;
  }
  if (typeof response.try === "number") {
    result.try = response.try;
  }
  if (typeof response.try_count === "number") {
    result.try_count = response.try_count;
  }
  if (response.process_history !== undefined && response.process_history !== null) {
    result.process_history = response.process_history;
  }
  if (search) {
    result.search = search;
  }
  for (const kind of ["master", "slave"] as const) {
    if (process !== "both" && process !== kind) {
      continue;
    }
    const text = response[`text_${kind}`];
    if (typeof text !== "string") {
      warnings.push(
        kind === "slave"
          ? "No slave log was returned. It is only available to operators, and for transfer jobs."
          : "No master log was returned.",
      );
      continue;
    }
    result[kind] = pageOfLines(text, { limit, page, search });
  }
  if (warnings.length > 0) {
    result.warning = warnings.join(" ");
  }
  return result;
}

function parseTask(task: string | number | undefined): string | undefined {
  if (task === undefined) {
    return undefined;
  }
  if (typeof task === "number" && !Number.isInteger(task)) {
    throw new Error('task must be a task URI such as "0".');
  }
  const uri = String(task).trim();
  if (!uri) {
    throw new Error('task must be a task URI such as "0".');
  }
  return uri;
}

/** Split into lines, keep the matching ones, and cut out one page counted from the end of the log. */
function pageOfLines(text: string, options: { limit: number; page: number; search?: string }): ProcessText {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const needle = options.search?.toLowerCase();
  const numbered: Array<{ n: number; line: string }> = [];
  lines.forEach((line, index) => {
    if (!needle || line.toLowerCase().includes(needle)) {
      numbered.push({ n: index + 1, line });
    }
  });
  const total = numbered.length;
  const pages = Math.max(1, Math.ceil(total / options.limit));
  const end = total - (options.page - 1) * options.limit;
  const selected = end > 0 ? numbered.slice(Math.max(0, end - options.limit), end) : [];
  const shown = selected.map(({ n, line }) => {
    const cut = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... [${line.length - MAX_LINE_LENGTH} more characters]` : line;
    return needle ? `${n}: ${cut}` : cut;
  });
  return {
    total_lines: total,
    page: options.page,
    pages,
    has_more: options.page < pages,
    ...(options.page < pages ? { next_page: options.page + 1 } : {}),
    ...(selected.length > 0 && !needle ? { first_line: selected[0].n } : {}),
    ...(needle ? { numbered: true } : {}),
    text: shown.join("\n"),
  };
}

/** When the task is unknown or missing, list the tasks of the job so the right one can be chosen. */
async function explainTaskError(session: TransferSession, jobId: string, error: unknown): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unknown task|need task uri/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  try {
    const found = await session.find("Task", { entityId: jobId });
    const tasks = (Array.isArray(found) ? found : found ? [found] : []).filter((task) => typeof task.uri === "string");
    if (tasks.length > 0) {
      const listed = tasks
        .slice(0, MAX_LISTED_TASKS)
        .map((task) => `${task.uri}${typeof task.status === "string" ? ` (${task.status})` : ""}`)
        .join(", ");
      const more = tasks.length > MAX_LISTED_TASKS ? `, and ${tasks.length - MAX_LISTED_TASKS} more` : "";
      return new Error(`${message} The tasks of this job are: ${listed}${more}. Pass one of them as task.`);
    }
  } catch {
    // The list is only a help, the original message is what matters.
  }
  return new Error(message);
}

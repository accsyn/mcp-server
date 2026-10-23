import type { FindTransfersOptions, TransferRecord, TransferSession } from "./transfers.js";

/** The general logs. A job can also be read on its own, see `LogFilters.job`. */
export const LOG_SCOPES = ["workspace", "job", "user"] as const;
export type LogScope = (typeof LOG_SCOPES)[number];

export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;
/** The most rows read from the backend for one call, that is `page * limit`. */
export const MAX_LOG_DEPTH = 5000;
/** Log texts can hold tracebacks. Longer texts are cut so that one row cannot flood the agent. */
export const MAX_TEXT_LENGTH = 1000;

const JOB_ATTRIBUTES = ["id", "code", "type", "status", "created", "finished"];
const FINISHED_STATUSES = new Set(["done", "aborted"]);
const MAX_LISTED_DUPLICATES = 10;

export interface LogRequest {
  entityType?: string | null;
  entityId?: string | null;
  search?: string;
  sort?: string;
  sortReverse?: boolean;
  /** First row to return, counted from 1 in the sort order. `-1` returns the last page. */
  paginationStart?: number;
  paginationSize?: number;
}

export interface LogSession {
  logs(options?: LogRequest): Promise<Record<string, unknown>>;
}

/** What reading logs needs from an accsyn `Session`: `logs` to read, and `find` to look a job up by name. */
export interface LogReader extends TransferSession, LogSession {}

export interface LogFilters {
  /** Which general log to read. Default `workspace`. Ignored when `job` or `jobId` is given. */
  scope?: LogScope;
  /** Name (code) of a job, to read the log of that one job. Transfers, deliveries and compute jobs are all jobs. */
  job?: string;
  /** ID of a job. Wins over `job`. */
  jobId?: string;
  /** Free text. Only rows containing it are returned, ignoring case. */
  search?: string;
  /** Rows per page. Default 50, at most 200. */
  limit?: number;
  /** Page number from 1. Page 1 holds the newest rows. */
  page?: number;
}

export interface LogEntry {
  /** Position in the whole log, counted from 1 for the oldest row. */
  index: number;
  date?: unknown;
  title?: string;
  text?: string;
  /** ID of the entity the row is about, for example a job. */
  ref?: string;
  /** Name of the entity the row is about. */
  ref_hr?: string;
  user?: string;
  ip?: string;
  device?: string;
}

export interface LogJob {
  id: string;
  code?: string;
  status?: string;
  created?: unknown;
}

export interface LogList {
  scope: LogScope;
  /** The job whose log was read, when a job was asked for. */
  job?: LogJob;
  /** Something the agent should tell the user, for example that several jobs have the same name. */
  warning?: string;
  search?: string;
  page: number;
  limit: number;
  pages: number;
  /** Rows on this page. */
  count: number;
  /** Rows in the log that matched `search`, over all pages. */
  total: number;
  has_more: boolean;
  /** Pass this as `page` to read the next older rows. */
  next_page?: number;
  /** Newest first. */
  entries: LogEntry[];
}

/**
 * Read a general log, or the log of one job, one page at a time with the newest rows first.
 *
 * The backend sorts a log oldest first and its page windows are unreliable except for the last page. So only the
 * newest `page * limit` rows are asked for, with `start: -1`, and the page is cut out here from each row's `index`.
 * A backend or API that returns more rows than asked for gives the same answer, only slower.
 */
export async function listLogs(session: LogReader, filters: LogFilters = {}): Promise<LogList> {
  const scope = filters.scope ?? "workspace";
  if (!LOG_SCOPES.includes(scope)) {
    throw new Error(`scope must be one of ${LOG_SCOPES.join(", ")}.`);
  }
  const limit = filters.limit ?? DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_LOG_LIMIT}.`);
  }
  const page = filters.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("page must be a whole number from 1.");
  }
  if (page * limit > MAX_LOG_DEPTH) {
    throw new Error(
      `page ${page} with ${limit} rows per page goes more than ${MAX_LOG_DEPTH} rows into the log. Use search to narrow the log down.`,
    );
  }
  const search = filters.search?.trim() || undefined;

  let job: LogJob | undefined;
  let warning: string | undefined;
  let entityId: string | undefined;
  if (filters.jobId !== undefined) {
    entityId = parseJobId(filters.jobId);
    job = { id: entityId };
  } else if (filters.job !== undefined) {
    const found = await findJob(session, filters.job);
    job = found.job;
    warning = found.warning;
    entityId = job.id;
  }

  const response = await session.logs({
    entityType: entityId ? "job" : scope,
    ...(entityId ? { entityId } : {}),
    ...(search ? { search } : {}),
    paginationStart: -1,
    paginationSize: page * limit,
  });

  const rows = Array.isArray(response?.result) ? (response.result as Array<Record<string, unknown>>) : [];
  const pagination = (response?.pagination ?? {}) as { total?: unknown };
  const total = typeof pagination.total === "number" ? pagination.total : rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));

  // Rows come oldest first. Row n of `total` is the (total - n)th newest, counted from 0.
  const firstRank = (page - 1) * limit;
  const entries = rows
    .map((row, position) => toEntry(row, typeof row.index === "number" ? row.index : total - rows.length + 1 + position))
    .filter((entry) => total - entry.index >= firstRank && total - entry.index < firstRank + limit)
    .sort((a, b) => b.index - a.index);

  if (page > pages && !warning) {
    warning = `Page ${page} is past the last page. The log has ${pages} page${pages === 1 ? "" : "s"} of ${limit} rows.`;
  }
  return {
    scope: entityId ? "job" : scope,
    ...(job ? { job } : {}),
    ...(warning ? { warning } : {}),
    ...(search ? { search } : {}),
    page,
    limit,
    pages,
    count: entries.length,
    total,
    has_more: page < pages,
    ...(page < pages ? { next_page: page + 1 } : {}),
    entries,
  };
}

function toEntry(row: Record<string, unknown>, index: number): LogEntry {
  const entry: LogEntry = { index };
  for (const key of ["date", "title", "text", "ref", "ref_hr", "user", "ip", "device"] as const) {
    const value = row[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    entry[key] = key === "text" && typeof value === "string" ? truncate(value) : (value as never);
  }
  return entry;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH
    ? `${text.slice(0, MAX_TEXT_LENGTH)}... [${text.length - MAX_TEXT_LENGTH} more characters]`
    : text;
}

export function parseJobId(value: string): string {
  const id = value.trim();
  if (!/^[0-9a-f]{24}$/i.test(id)) {
    throw new Error("job_id must be a job ID, 24 hexadecimal characters. Use job to look a job up by name.");
  }
  return id;
}

/** Find a job by name among running and finished jobs. When several have the name, the most recent is used. */
export async function findJob(session: TransferSession, name: string): Promise<{ job: LogJob; warning?: string }> {
  const code = name.trim();
  if (!code || code.includes("'") || code.includes('"')) {
    throw new Error("Provide a job name, for example myupload.");
  }
  const rows: TransferRecord[] = [];
  for (const finished of [false, true]) {
    const options: FindTransfersOptions = { attributes: JOB_ATTRIBUTES, ...(finished ? { finished: true } : {}) };
    const found = await session.find(`Job WHERE code='${code}'`, options);
    const list = Array.isArray(found) ? found : found ? [found] : [];
    rows.push(...list.filter((row) => isFinished(row) === finished));
  }
  // The query is case insensitive and treats * as a wildcard, so only keep exact names.
  const seen = new Set<string>();
  const matches = rows
    .filter((row) => typeof row.id === "string" && typeof row.code === "string" && row.code.toLowerCase() === code.toLowerCase())
    .filter((row) => (seen.has(row.id as string) ? false : (seen.add(row.id as string), true)))
    .sort((a, b) => createdTime(b) - createdTime(a));
  if (matches.length === 0) {
    throw new Error(`No job named "${code}" was found. Names must match exactly, ignoring case.`);
  }
  const [first, ...others] = matches;
  const job = summarize(first);
  if (others.length === 0) {
    return { job };
  }
  const listed = others
    .slice(0, MAX_LISTED_DUPLICATES)
    .map((row) => `${row.id} (${row.status ?? "unknown"}, created ${String(row.created ?? "unknown")})`)
    .join("; ");
  const more = others.length > MAX_LISTED_DUPLICATES ? `; and ${others.length - MAX_LISTED_DUPLICATES} more` : "";
  return {
    job,
    warning:
      `${matches.length} jobs are named "${code}". Using the most recent one, ${job.id}. ` +
      `The others are: ${listed}${more}. Pass job_id to read one of those instead.`,
  };
}

function summarize(row: TransferRecord): LogJob {
  return {
    id: row.id as string,
    ...(typeof row.code === "string" ? { code: row.code } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    ...(row.created !== undefined && row.created !== null ? { created: row.created } : {}),
  };
}

function createdTime(row: TransferRecord): number {
  const value = row.created;
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

function isFinished(row: TransferRecord): boolean {
  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  return FINISHED_STATUSES.has(status);
}

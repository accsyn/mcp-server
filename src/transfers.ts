/** Job type for a file transfer. Matches the accsyn backend TYPE_TRANSFER. */
export const TRANSFER_TYPE = 1;

const FINISHED_STATUSES = new Set(["done", "aborted"]);

/** Statuses a transfer can have. Used for hints only, any status word is passed through. */
export const TRANSFER_STATUSES = ["pending", "waiting", "running", "paused", "failed", "aborted", "done"];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const ATTRIBUTES = [
  "id",
  "code",
  "status",
  "type",
  "progress",
  "size",
  "speed",
  "etr",
  "source",
  "destination",
  "user",
  "uri",
  "status_hr",
  "created",
  "finished",
];

export interface TransferRecord {
  id?: string;
  [key: string]: unknown;
}

export interface FindTransfersOptions {
  attributes?: string[];
  /** The parent entity, for example the job ID when finding the tasks of a job. */
  entityId?: string;
  /** Search finished (done and aborted) jobs instead of live jobs. */
  finished?: boolean;
}

export interface TransferSession {
  find(query: string, options?: FindTransfersOptions): Promise<TransferRecord[] | TransferRecord | null>;
}

/** Which transfers to search: not finished yet, done or aborted, or both. */
export type TransferState = "active" | "finished" | "all";

/** All filters are optional. Filters that are given must all match. */
export interface TransferFilters {
  /** Email of the user who created the transfers. */
  user?: string;
  /** Default `active`. */
  state?: TransferState;
  /** Only transfers with one of these statuses. A comma separated string is accepted as well. */
  status?: string[] | string;
  /**
   * The sending party, for "downloaded from X". A party is `user:<text>`, `site:<text>` or `workspace`, where
   * `<text>` must be contained in the party name (case insensitive). `user:`, `site:` and `workspace` alone match
   * any party of that type. A bare `<text>` matches a party of any type.
   */
  source?: string;
  /** The receiving party, for "uploaded to X". Same form as `source`. */
  destination?: string;
  /** ISO dates or date times. A date without a time means the start of that day, UTC. */
  createdAfter?: string;
  createdBefore?: string;
  finishedAfter?: string;
  finishedBefore?: string;
  /** Default 50, at most 200. */
  limit?: number;
}

export interface TransferList {
  /** Number of transfers returned. */
  count: number;
  /** Number of transfers that matched the filters, before `limit` was applied. */
  total: number;
  /** True when `total` is larger than `count`. */
  truncated: boolean;
  /** The filters that were applied, with defaults filled in. */
  filters: Record<string, unknown>;
  /** Most recent first: by finish time for `finished`, otherwise by creation time. */
  transfers: TransferRecord[];
}

/**
 * List transfers matching any combination of filters.
 *
 * `user` and `status` are part of the backend query, so the backend limit applies after they have been matched.
 * Dates are compared here, because the backend query compares text and cannot compare dates.
 */
export async function listTransfers(session: TransferSession, filters: TransferFilters = {}): Promise<TransferList> {
  const state = filters.state ?? "active";
  if (!["active", "finished", "all"].includes(state)) {
    throw new Error('state must be "active", "finished" or "all".');
  }
  const user = filters.user?.trim();
  if (filters.user !== undefined && (!user || hasQuote(user))) {
    throw new Error("Provide a user email, for example john@user.com.");
  }
  const statuses = normalizeStatuses(filters.status);
  const limit = filters.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  const source = parseParty("source", filters.source);
  const destination = parseParty("destination", filters.destination);
  const createdAfter = parseDate("created_after", filters.createdAfter);
  const createdBefore = parseDate("created_before", filters.createdBefore);
  const finishedAfter = parseDate("finished_after", filters.finishedAfter);
  const finishedBefore = parseDate("finished_before", filters.finishedBefore);

  const conditions: string[] = [];
  if (user) {
    conditions.push(`creator='${user}'`);
  }
  if (statuses.length === 1) {
    conditions.push(`status=${statuses[0]}`);
  } else if (statuses.length > 1) {
    conditions.push(`status in ${statuses.join(",")}`);
  }
  const query = conditions.length ? `Transfer WHERE ${conditions.join(" AND ")}` : "Transfer";

  const rows: TransferRecord[] = [];
  for (const finished of state === "all" ? [false, true] : [state === "finished"]) {
    const found = await session.find(query, { attributes: ATTRIBUTES, ...(finished ? { finished: true } : {}) });
    const list = Array.isArray(found) ? found : found ? [found] : [];
    rows.push(...list.filter((job) => isFinished(job) === finished));
  }

  const matched = dedupe(rows).filter(
    (job) =>
      matchesParty(job, "source", source) &&
      matchesParty(job, "destination", destination) &&
      inRange(job.created, createdAfter, createdBefore) &&
      inRange(job.finished, finishedAfter, finishedBefore),
  );
  matched.sort((a, b) => sortTime(b, state) - sortTime(a, state));
  const transfers = matched.slice(0, limit);
  return {
    count: transfers.length,
    total: matched.length,
    truncated: matched.length > transfers.length,
    filters: {
      user,
      state,
      status: statuses.length ? statuses : undefined,
      source: filters.source,
      destination: filters.destination,
      created_after: filters.createdAfter,
      created_before: filters.createdBefore,
      finished_after: filters.finishedAfter,
      finished_before: filters.finishedBefore,
      limit,
    },
    transfers,
  };
}

function hasQuote(value: string): boolean {
  return value.includes("'") || value.includes('"');
}

function normalizeStatuses(status: string[] | string | undefined): string[] {
  if (status === undefined) {
    return [];
  }
  const words = (Array.isArray(status) ? status : status.split(","))
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
  for (const word of words) {
    if (!/^[a-z_]+$/.test(word)) {
      throw new Error(`Invalid status "${word}". Use words such as ${TRANSFER_STATUSES.join(", ")}.`);
    }
  }
  return [...new Set(words)];
}

const PARTY_TYPES = ["user", "site", "workspace"] as const;
type PartyType = (typeof PARTY_TYPES)[number];

interface PartyFilter {
  type?: PartyType;
  /** Lower case text that the party name must contain. Empty matches any name. */
  name: string;
}

function asPartyType(value: string): PartyType | undefined {
  const type = value.toLowerCase();
  return (PARTY_TYPES as readonly string[]).includes(type) ? (type as PartyType) : undefined;
}

function parseParty(argument: string, value: string | undefined): PartyFilter | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${argument} must be a party such as user:tom@berlinvfx.com, site:london or workspace.`);
  }
  const bareType = asPartyType(text);
  if (bareType) {
    return { type: bareType, name: "" };
  }
  const colon = text.indexOf(":");
  const type = colon > 0 ? asPartyType(text.slice(0, colon)) : undefined;
  return type ? { type, name: text.slice(colon + 1).trim().toLowerCase() } : { name: text.toLowerCase() };
}

/** The party type is the prefix of the human readable form, for example `user` in `user:tom@berlinvfx.com[standard](id)`. */
function partyType(job: TransferRecord, side: "source" | "destination"): PartyType | undefined {
  const text = job[`${side}_hr`];
  if (typeof text !== "string") {
    return undefined;
  }
  const colon = text.indexOf(":");
  return colon > 0 ? asPartyType(text.slice(0, colon)) : undefined;
}

/** The party name from a human readable form such as `user:tom@berlinvfx.com[standard](6676f3e9c7ef4e27da254e57)`. */
function partyName(job: TransferRecord, side: "source" | "destination"): string {
  const text = job[`${side}_hr`];
  if (typeof text !== "string") {
    return "";
  }
  return text
    .replace(/^[a-z]+:/i, "")
    .replace(/(\[[^\]]*\])?(\([^)]*\))?$/, "")
    .toLowerCase();
}

function matchesParty(job: TransferRecord, side: "source" | "destination", filter: PartyFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.type && partyType(job, side) !== filter.type) {
    return false;
  }
  return filter.name === "" || partyName(job, side).includes(filter.name);
}

function parseDate(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new Error(`${name} must be an ISO date such as 2026-10-01 or 2026-10-01T12:00:00Z.`);
  }
  return time;
}

/** Epoch milliseconds of a Date or date string from the API, or undefined when there is no usable date. */
function toTime(value: unknown): number | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

/** A transfer without a date never matches a date limit. */
function inRange(value: unknown, after: number | undefined, before: number | undefined): boolean {
  if (after === undefined && before === undefined) {
    return true;
  }
  const time = toTime(value);
  if (time === undefined) {
    return false;
  }
  return (after === undefined || time > after) && (before === undefined || time < before);
}

function sortTime(job: TransferRecord, state: TransferState): number {
  const created = toTime(job.created) ?? 0;
  return state === "finished" ? (toTime(job.finished) ?? created) : created;
}

function dedupe(rows: TransferRecord[]): TransferRecord[] {
  const seen = new Set<string>();
  return rows.filter((job) => {
    const key = job.id ?? (typeof job.code === "string" ? job.code : undefined);
    if (key === undefined) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isFinished(job: TransferRecord): boolean {
  const status = typeof job.status === "string" ? job.status.toLowerCase() : "";
  return FINISHED_STATUSES.has(status);
}

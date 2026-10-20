/** Job type for a file transfer. Matches the accsyn backend TYPE_TRANSFER. */
export const TRANSFER_TYPE = 1;

const FINISHED_STATUSES = new Set(["done", "aborted"]);

const ATTRIBUTES = [
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
  /** Search finished (done and aborted) jobs instead of live jobs. */
  finished?: boolean;
}

export interface TransferSession {
  find(query: string, options?: FindTransfersOptions): Promise<TransferRecord[] | TransferRecord | null>;
}

export interface TransferList {
  user: string;
  count: number;
  transfers: TransferRecord[];
}

/**
 * Active transfers owned by a user.
 * The default job query omits finished and aborted jobs. Deliveries, queues, and compute jobs are filtered out.
 */
export async function listActiveTransfers(session: TransferSession, user: string): Promise<TransferList> {
  return listTransfers(session, user, false);
}

/**
 * Finished transfers (status done or aborted) owned by a user, most recently finished first.
 * The backend caps the number of finished jobs it returns, so very old transfers may be missing.
 */
export async function listFinishedTransfers(session: TransferSession, user: string): Promise<TransferList> {
  return listTransfers(session, user, true);
}

async function listTransfers(session: TransferSession, user: string, finished: boolean): Promise<TransferList> {
  const email = user.trim();
  if (!email || email.includes("'") || email.includes('"')) {
    throw new Error("Provide a user email, for example john@user.com.");
  }
  const found = await session.find(`Transfer WHERE creator='${email}'`, {
    attributes: ATTRIBUTES,
    ...(finished ? { finished: true } : {}),
  });
  const rows = Array.isArray(found) ? found : found ? [found] : [];
  const transfers = rows.filter((job) => isFinished(job) === finished);
  return { user: email, count: transfers.length, transfers };
}

function isFinished(job: TransferRecord): boolean {
  const status = typeof job.status === "string" ? job.status.toLowerCase() : "";
  return FINISHED_STATUSES.has(status);
}

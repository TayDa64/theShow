/**
 * Read-only production feed.
 *
 * readdir, readFile, JSON.parse, and zod. It does not write, rename, delete,
 * truncate, claim, reap, or call an MCP tool. A missing or torn log is reconciled
 * from the job file. The job file wins.
 *
 * Grok Bot pages, routines, Studio, and any other observer are optional readers.
 * Production does not require them.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { assessBudget, type BudgetAssessment, type SpendKind } from "./costGate";
import { JOBS_DIR } from "./media";
import {
  canonicalJson,
  deriveJobEvents,
  eventId,
  eventLogPath,
  isSafeJobId,
  parseEventLog,
  type DerivedEvent,
  type EventJob,
  type ParsedEvent,
} from "./jobEvents";
import { isLoopbackHost, jobShouldStop, pidAlive, type JobOwner } from "./runtime";

export type SpendNoteInput = {
  op: "budget";
  thresholdUsd: number;
} | {
  op: "spend";
  kind: SpendKind;
  usd: number;
  estimated?: boolean;
  uncertain?: boolean;
  reason?: string;
};

export type SpendNote = SpendNoteInput & { id: string };

export type QueuedFilmSpend = {
  pendingSpendUsd: number;
  pendingThresholdUsd?: number;
};

export type FeedAbstention = { path: string; reason: string };

export type FeedEvent = {
  id: string;
  jobId: string;
  type: string;
  source: "log" | "reconciled" | "journal";
  seq?: number;
  revision?: number;
  recordedAt?: number;
  at?: number;
  data: Record<string, unknown>;
};

export type FeedJobSummary = {
  jobId: string;
  state: string;
  progress: { completed: number; shotCount: number };
  spentUsd: number;
  pendingSpendUsd: number;
  pendingThresholdUsd?: number;
  budget: BudgetAssessment;
  review?: { findings: number; measured: number; visuallyFlagged: number; unverified: number };
  repairProposal?: { options: Array<{ id: string; costUsd: number; requiresApproval: true }> };
  filmPath?: string;
  liveness: "running" | "owner-gone-awaiting-reap" | "claimed" | "idle";
  log: {
    present: boolean;
    events: number;
    tornLines: number;
    seqCollisions: number;
    capped: boolean;
    behind: boolean;
  };
};

export type ProductionFeed = {
  version: 1;
  generatedAt: string;
  cursor: string;
  jobs: FeedJobSummary[];
  events: FeedEvent[];
  abstentions: FeedAbstention[];
  truncated: boolean;
};

export type FeedRefusal = { refused: true; reason: string };

type LoadedJob = {
  job: EventJob & {
    completed?: number;
    spentUsd?: number;
    filmPath?: string;
    owner?: Partial<JobOwner>;
    claim?: Partial<JobOwner>;
  };
};

const feedJobSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  state: z.string(),
  revision: z.number().optional(),
  shotCount: z.number().optional(),
  completed: z.number().optional(),
  spentUsd: z.number().optional(),
  filmPath: z.string().optional(),
  shots: z.array(z.object({
    index: z.number().optional(),
    status: z.string().optional(),
    costUsd: z.number().optional(),
  }).passthrough()).optional(),
  continuityReview: z.unknown().optional(),
  repairProposal: z.unknown().optional(),
  spendLedger: z.unknown().optional(),
  owner: z.unknown().optional(),
  claim: z.unknown().optional(),
}).passthrough();

function spendJournalDir(jobId: string, jobsDir = JOBS_DIR): string {
  return join(jobsDir, ".spend-journal", jobId);
}

function isSpendNote(value: unknown): value is SpendNote {
  if (!value || typeof value !== "object") return false;
  const note = value as { id?: unknown; op?: unknown; usd?: unknown; thresholdUsd?: unknown };
  if (typeof note.id !== "string" || note.id.length === 0) return false;
  if (note.op === "budget") return typeof note.thresholdUsd === "number";
  if (note.op === "spend") return typeof note.usd === "number";
  return false;
}

/** Read queued notes without merging them and without deleting anything. */
export async function listJournal(
  jobId: string,
  jobsDir = JOBS_DIR,
): Promise<{ valid: { file: string; note: SpendNote }[]; torn: string[] }> {
  const dir = spendJournalDir(jobId, jobsDir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { valid: [], torn: [] };
  }
  names.sort();
  const valid: { file: string; note: SpendNote }[] = [];
  const torn: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    if (!name.endsWith(".json") || name.startsWith(".")) {
      const pid = Number(name.match(/\.(\d+)\.tmp$/)?.[1]);
      if (Number.isFinite(pid) && (pid === process.pid || pidAlive(pid))) continue;
      torn.push(file);
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (!isSpendNote(parsed)) torn.push(file);
      else valid.push({ file, note: parsed });
    } catch {
      torn.push(file);
    }
  }
  return { valid, torn };
}

/** Read queued notes without merging them and without deleting anything. */
export async function readQueuedFilmSpend(
  jobId: string,
  appliedNoteIds?: string[],
  jobsDir = JOBS_DIR,
): Promise<QueuedFilmSpend> {
  const { valid } = await listJournal(jobId, jobsDir);
  const applied = new Set(appliedNoteIds ?? []);
  let pendingSpendUsd = 0;
  let pendingThresholdUsd: number | undefined;
  for (const { note } of valid) {
    if (applied.has(note.id)) continue;
    if (note.op === "spend") pendingSpendUsd += note.usd;
    else pendingThresholdUsd = note.thresholdUsd;
  }
  const rounded = Math.round(pendingSpendUsd * 100) / 100;
  return {
    pendingSpendUsd: rounded,
    ...(pendingThresholdUsd !== undefined ? { pendingThresholdUsd } : {}),
  };
}

export { spendJournalDir };

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function asOwner(value: unknown): JobOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const owner = value as Partial<JobOwner>;
  if (typeof owner.pid !== "number" || typeof owner.token !== "string") return undefined;
  if (typeof owner.host !== "string" || typeof owner.heartbeatAt !== "number") return undefined;
  return { pid: owner.pid, token: owner.token, host: owner.host, heartbeatAt: owner.heartbeatAt };
}

function spentOf(job: LoadedJob["job"]): number {
  const entries = job.spendLedger?.entries ?? [];
  if (entries.length > 0) {
    return roundUsd(entries.reduce((sum, entry) => sum + (typeof entry.usd === "number" ? entry.usd : 0), 0));
  }
  if (typeof job.spentUsd === "number") return roundUsd(job.spentUsd);
  return roundUsd((job.shots ?? []).reduce((sum, shot) => sum + (shot.costUsd ?? 0), 0));
}

function reviewOf(review: unknown): FeedJobSummary["review"] | undefined {
  if (!review || typeof review !== "object") return undefined;
  const findings = Array.isArray((review as { findings?: unknown }).findings)
    ? (review as { findings: Array<{ class?: unknown }> }).findings
    : [];
  let measured = 0;
  let visuallyFlagged = 0;
  let unverified = 0;
  for (const finding of findings) {
    if (finding?.class === "measured") measured += 1;
    else if (finding?.class === "visually-flagged") visuallyFlagged += 1;
    else if (finding?.class === "unverified") unverified += 1;
  }
  return { findings: findings.length, measured, visuallyFlagged, unverified };
}

function repairOf(proposal: unknown): FeedJobSummary["repairProposal"] | undefined {
  if (!proposal || typeof proposal !== "object") return undefined;
  const options = Array.isArray((proposal as { options?: unknown }).options)
    ? (proposal as { options: Array<{ id?: unknown; costUsd?: unknown }> }).options
    : [];
  return {
    options: options.flatMap((option) => (
      typeof option?.id === "string" && typeof option.costUsd === "number"
        ? [{ id: option.id, costUsd: option.costUsd, requiresApproval: true as const }]
        : []
    )),
  };
}

export async function readEventLog(jobsDir: string, jobId: string): Promise<{
  present: boolean;
  unreadable: boolean;
  events: ParsedEvent[];
  tornLines: number;
  seqCollisions: number;
  capped: boolean;
  maxRevision?: number;
}> {
  const logPath = eventLogPath(jobsDir, jobId);
  if (!logPath) return { present: false, unreadable: false, events: [], tornLines: 0, seqCollisions: 0, capped: false };
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, unreadable: false, events: [], tornLines: 0, seqCollisions: 0, capped: false };
    }
    return { present: false, unreadable: true, events: [], tornLines: 0, seqCollisions: 0, capped: false };
  }
  const parsed = parseEventLog(raw, jobId);
  return { present: true, unreadable: false, ...parsed };
}

function reconciledAt(type: string, job: EventJob): number | undefined {
  if (type === "job.started" && typeof job.startedAt === "number") return job.startedAt;
  if ((type === "job.completed" || type === "job.stopped" || type === "job.failed") && typeof job.finishedAt === "number") {
    return job.finishedAt;
  }
  return undefined;
}

function livenessOf(job: LoadedJob["job"], now: number): FeedJobSummary["liveness"] {
  if (job.state === "running") {
    return jobShouldStop(asOwner(job.owner), now) ? "owner-gone-awaiting-reap" : "running";
  }
  const claim = asOwner(job.claim);
  if (claim && !jobShouldStop(claim, now)) return "claimed";
  return "idle";
}

async function loadJobFile(jobsDir: string, name: string): Promise<{ job?: LoadedJob["job"]; abstention?: FeedAbstention }> {
  const stem = name.slice(0, -".json".length);
  if (!isSafeJobId(stem)) return { abstention: { path: name, reason: "job id is not confined" } };
  let raw: string;
  try {
    raw = await readFile(join(jobsDir, name), "utf8");
  } catch {
    return { abstention: { path: name, reason: "unreadable" } };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { abstention: { path: name, reason: "invalid JSON" } };
  }
  const parsed = feedJobSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== stem) {
    return { abstention: { path: name, reason: "invalid job" } };
  }
  return { job: parsed.data as LoadedJob["job"] };
}

export async function readJobsForFeed(jobsDir: string): Promise<{ jobs: LoadedJob["job"][]; abstentions: FeedAbstention[] }> {
  let names: string[] = [];
  try {
    names = await readdir(jobsDir);
  } catch {
    return { jobs: [], abstentions: [] };
  }
  const jobs: LoadedJob["job"][] = [];
  const abstentions: FeedAbstention[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const loaded = await loadJobFile(jobsDir, name);
    if (loaded.abstention) abstentions.push(loaded.abstention);
    else if (loaded.job) jobs.push(loaded.job);
  }
  jobs.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || (left.id < right.id ? -1 : 1));
  return { jobs, abstentions };
}

type CursorMark = { seq: number; ids: string[] };
type CursorBody = { v: 1; jobs: Record<string, { seq: number; reconciledDigest: string }> };

function digestIds(ids: string[]): string {
  const sorted = [...ids].sort();
  const hash = createHash("sha256").update(sorted.join("\0")).digest("hex");
  const body = Buffer.from(JSON.stringify(sorted), "utf8").toString("base64url");
  return `${hash}.${body}`;
}

function undigest(value: string): string[] | undefined {
  const dot = value.indexOf(".");
  if (dot <= 0) return undefined;
  const hash = value.slice(0, dot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(dot + 1), "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) return undefined;
  const sorted = [...(parsed as string[])].sort();
  const check = createHash("sha256").update(sorted.join("\0")).digest("hex");
  if (check !== hash) return undefined;
  return sorted;
}

function encodeCursor(marks: Map<string, CursorMark>): string {
  const jobs: CursorBody["jobs"] = {};
  for (const [jobId, mark] of marks) {
    jobs[jobId] = { seq: mark.seq, reconciledDigest: digestIds(mark.ids) };
  }
  const body: CursorBody = { v: 1, jobs };
  return Buffer.from(canonicalJson(body), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): Map<string, CursorMark> | undefined {
  if (!cursor) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  const parsed = z.object({
    v: z.literal(1),
    jobs: z.record(z.string(), z.object({
      seq: z.number().int().nonnegative(),
      reconciledDigest: z.string(),
    })),
  }).safeParse(value);
  if (!parsed.success) return undefined;
  const marks = new Map<string, CursorMark>();
  for (const [jobId, mark] of Object.entries(parsed.data.jobs)) {
    if (!isSafeJobId(jobId)) return undefined;
    const ids = undigest(mark.reconciledDigest);
    if (!ids) return undefined;
    marks.set(jobId, { seq: mark.seq, ids });
  }
  return marks;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function journalEvent(jobId: string, note: SpendNote): FeedEvent {
  const data: Record<string, unknown> = note.op === "spend"
    ? { op: "spend", kind: note.kind, usd: note.usd }
    : { op: "budget", thresholdUsd: note.thresholdUsd };
  return {
    id: eventId(jobId, "spend.queued", note.id),
    jobId,
    type: "spend.queued",
    source: "journal",
    data,
  };
}

function fromLog(event: ParsedEvent): FeedEvent {
  return {
    id: event.id,
    jobId: event.jobId,
    type: event.type,
    source: "log",
    seq: event.seq,
    ...(event.revision !== undefined ? { revision: event.revision } : {}),
    ...(event.recordedAt !== undefined ? { recordedAt: event.recordedAt } : {}),
    data: event.data,
  };
}

function fromReconciled(job: EventJob, event: DerivedEvent): FeedEvent {
  const at = reconciledAt(event.type, job);
  return {
    id: event.id,
    jobId: job.id,
    type: event.type,
    source: "reconciled",
    ...(at !== undefined ? { at } : {}),
    data: event.data,
  };
}

function eventSort(left: FeedEvent, right: FeedEvent): number {
  const seq = (event: FeedEvent) => event.seq ?? Number.MAX_SAFE_INTEGER;
  const at = (event: FeedEvent) => event.recordedAt ?? Number.MAX_SAFE_INTEGER;
  return seq(left) - seq(right) || at(left) - at(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function seen(mark: CursorMark | undefined, event: FeedEvent): boolean {
  if (!mark) return false;
  if (mark.ids.includes(event.id)) return true;
  return event.source === "log" && event.seq !== undefined && event.seq <= mark.seq;
}

export async function readProductionFeed(input: {
  jobsDir: string;
  cursor?: string;
  limit?: number;
  jobId?: string;
  now?: number;
}): Promise<ProductionFeed | FeedRefusal> {
  if (input.jobId !== undefined && !isSafeJobId(input.jobId)) {
    return { refused: true, reason: "jobId is not confined to the jobs directory" };
  }
  const marks = decodeCursor(input.cursor);
  const cursor = marks ?? new Map<string, CursorMark>();
  const loaded = await readJobsForFeed(input.jobsDir);
  const selected = input.jobId ? loaded.jobs.filter((job) => job.id === input.jobId) : loaded.jobs;
  const abstentions = [...loaded.abstentions];
  const now = input.now ?? Date.now();
  const summaries: FeedJobSummary[] = [];
  const allEvents: FeedEvent[] = [];

  for (const job of selected) {
    const log = await readEventLog(input.jobsDir, job.id);
    if (log.unreadable) abstentions.push({ path: `${job.id}.jsonl`, reason: "unreadable event log" });
    const derived = deriveJobEvents(job);
    const loggedIds = new Set(log.events.map((event) => event.id));
    const missing = derived.filter((event) => !loggedIds.has(event.id));
    const behind = !log.present
      || missing.length > 0
      || (typeof job.revision === "number" && log.present && (log.maxRevision === undefined || log.maxRevision < job.revision));
    const journal = isSafeJobId(job.id) ? await listJournal(job.id, input.jobsDir) : { valid: [], torn: [] };
    for (const file of journal.torn) abstentions.push({ path: basename(file), reason: "torn journal note" });
    const queued = await readQueuedFilmSpend(job.id, job.spendLedger?.appliedNoteIds, input.jobsDir);
    const events = [
      ...log.events.map(fromLog),
      ...missing.map((event) => fromReconciled(job, event)),
      ...journal.valid
        .filter((entry) => !(job.spendLedger?.appliedNoteIds ?? []).includes(entry.note.id))
        .map((entry) => journalEvent(job.id, entry.note)),
    ].sort(eventSort);
    allEvents.push(...events);
    const summary: FeedJobSummary = {
      jobId: job.id,
      state: job.state ?? "unknown",
      progress: {
        completed: job.completed ?? 0,
        shotCount: job.shotCount ?? job.shots?.length ?? 0,
      },
      spentUsd: spentOf(job),
      pendingSpendUsd: queued.pendingSpendUsd,
      ...(queued.pendingThresholdUsd !== undefined ? { pendingThresholdUsd: queued.pendingThresholdUsd } : {}),
      budget: assessBudget({
        spentUsd: spentOf(job),
        pendingUsd: queued.pendingSpendUsd,
        thresholdUsd: job.spendLedger?.thresholdUsd,
      }),
      ...(reviewOf(job.continuityReview) ? { review: reviewOf(job.continuityReview) } : {}),
      ...(job.repairProposal ? { repairProposal: repairOf(job.repairProposal) } : {}),
      ...(typeof job.filmPath === "string" && job.filmPath.length > 0 ? { filmPath: basename(job.filmPath) } : {}),
      liveness: livenessOf(job, now),
      log: {
        present: log.present,
        events: log.events.length,
        tornLines: log.tornLines,
        seqCollisions: log.seqCollisions,
        capped: log.capped,
        behind,
      },
    };
    summaries.push(summary);
  }

  const limit = clampLimit(input.limit);
  const unseen = marks
    ? allEvents.filter((event) => !seen(cursor.get(event.jobId), event))
    : allEvents;
  const page: FeedEvent[] = [];
  for (const event of unseen) {
    if (page.length >= limit) {
      const last = page[page.length - 1];
      if (!(last?.source === "log" && event.source === "log" && last.seq !== undefined && last.seq === event.seq)) break;
    }
    page.push(event);
  }
  const next = new Map(cursor);
  for (const event of page) {
    const mark = next.get(event.jobId) ?? { seq: 0, ids: [] };
    if (event.source === "log" && event.seq !== undefined) mark.seq = Math.max(mark.seq, event.seq);
    else if (!mark.ids.includes(event.id)) mark.ids.push(event.id);
    next.set(event.jobId, mark);
  }
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    cursor: encodeCursor(next),
    jobs: summaries,
    events: page,
    abstentions,
    truncated: page.length < unseen.length,
  };
}

function hostWithoutPort(header: string): { host: string; ok: boolean } {
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end <= 1) return { host: "", ok: false };
    const rest = value.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return { host: "", ok: false };
    return { host: value.slice(1, end), ok: true };
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1)) && value.indexOf(":") === colon) {
    return { host: value.slice(0, colon), ok: true };
  }
  return { host: value, ok: true };
}

function peerIsLoopback(peer: string): boolean {
  const bare = peer.trim().toLowerCase().replace(/^::ffff:/, "").split("%")[0] ?? "";
  return bare === "127.0.0.1" || bare === "::1";
}

/**
 * Studio listens on 0.0.0.0. The feed answers only a loopback peer whose Host
 * header also names a loopback host. Bracketed IPv6 and IPv4-mapped peers are
 * accepted here; isLoopbackHost itself is unchanged.
 */
export function studioFeedRequestAllowed(peer: string | undefined, hostHeader: string | undefined): boolean {
  if (!peer || !hostHeader) return false;
  if (!peerIsLoopback(peer)) return false;
  const parsed = hostWithoutPort(hostHeader);
  if (!parsed.ok) return false;
  if (parsed.host === "::1") return true;
  return isLoopbackHost(parsed.host);
}

/** Directory the feed reads. Honors THESHOW_JOBS_DIR even after mcp/media.ts was imported. */
export function feedJobsDir(): string {
  return process.env.THESHOW_JOBS_DIR || JOBS_DIR;
}

export const productionFeedResultSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  cursor: z.string(),
  jobs: z.array(z.object({
    jobId: z.string(),
    state: z.string(),
    progress: z.object({ completed: z.number(), shotCount: z.number() }),
    spentUsd: z.number(),
    pendingSpendUsd: z.number(),
    pendingThresholdUsd: z.number().optional(),
    budget: z.object({
      version: z.literal(1),
      spentUsd: z.number(),
      pendingUsd: z.number(),
      totalUsd: z.number(),
      thresholdUsd: z.number().optional(),
      crossed: z.boolean(),
      warning: z.string().optional(),
      authorizesSpend: z.literal(false),
    }),
    review: z.object({
      findings: z.number(),
      measured: z.number(),
      visuallyFlagged: z.number(),
      unverified: z.number(),
    }).optional(),
    repairProposal: z.object({
      options: z.array(z.object({
        id: z.string(),
        costUsd: z.number(),
        requiresApproval: z.literal(true),
      })),
    }).optional(),
    filmPath: z.string().optional(),
    liveness: z.enum(["running", "owner-gone-awaiting-reap", "claimed", "idle"]),
    log: z.object({
      present: z.boolean(),
      events: z.number(),
      tornLines: z.number(),
      seqCollisions: z.number(),
      capped: z.boolean(),
      behind: z.boolean(),
    }),
  })),
  events: z.array(z.object({
    id: z.string(),
    jobId: z.string(),
    type: z.string(),
    source: z.enum(["log", "reconciled", "journal"]),
    seq: z.number().optional(),
    revision: z.number().optional(),
    recordedAt: z.number().optional(),
    at: z.number().optional(),
    data: z.record(z.string(), z.unknown()),
  })),
  abstentions: z.array(z.object({
    path: z.string(),
    reason: z.string(),
  })),
  truncated: z.boolean(),
});

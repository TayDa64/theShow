/**
 * Append-only per-job event log.
 *
 * The job file stays authoritative. This module records transitions the job
 * writer already committed. A failure here is logged once and swallowed.
 * It does not import the MCP SDK, an HTTP stack, or mcp/server.ts.
 *
 * O_APPEND line atomicity is assumed only on local filesystems, the same
 * scope as the link() fallbacks in mcp/runtime.ts.
 */
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { processToken, trackWrite, type JobOwner } from "./runtime";

export const EVENT_LOG_VERSION = 1;
export const MAX_EVENT_LINE_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_JOB = 2_000;
export const MAX_EVENT_LOG_BYTES = 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type EventJob = {
  id: string;
  state?: string;
  shotCount?: number;
  startedAt?: number;
  finishedAt?: number;
  revision?: number;
  shots?: Array<{ index?: number; status?: string; costUsd?: number }>;
  continuityReview?: unknown;
  repairProposal?: { options?: Array<{ id?: unknown; costUsd?: unknown }> } | null;
  spendLedger?: {
    thresholdUsd?: number;
    entries?: Array<{
      kind?: unknown;
      usd?: unknown;
      estimated?: boolean;
      derived?: boolean;
      uncertain?: boolean;
      reason?: string;
    }>;
    appliedNoteIds?: string[];
  };
  owner?: Partial<JobOwner>;
  claim?: Partial<JobOwner>;
};

export type DerivedEvent = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

export type ParsedEvent = DerivedEvent & {
  seq: number;
  jobId: string;
  revision?: number;
  recordedAt?: number;
};

export type ParsedLog = {
  events: ParsedEvent[];
  tornLines: number;
  seqCollisions: number;
  capped: boolean;
  maxSeq: number;
  maxRevision?: number;
};

type EventFs = {
  appendFile: (path: string, data: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  mkdir: (path: string) => Promise<void>;
};

const defaultFs: EventFs = {
  appendFile: (path, data) => appendFile(path, data, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

let eventFs: EventFs = defaultFs;
let beforeAppend: (() => Promise<void>) | undefined;
const fingerprints = new Map<string, string>();
const chains = new Map<string, Promise<void>>();
const reportedFailures = new Set<string>();
const reportedSkips = new Set<string>();

/** Canonical JSON: sorted keys, undefined omitted. Formatting whitespace is not part of the encoding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function isSafeJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

/** Confined log path. Any other id returns undefined and nothing is opened. */
export function eventLogPath(jobsDir: string, jobId: string): string | undefined {
  if (!isSafeJobId(jobId)) return undefined;
  const root = resolve(jobsDir, ".events");
  const full = resolve(root, `${jobId}.jsonl`);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel) || rel !== `${jobId}.jsonl`) return undefined;
  return full;
}

export function eventId(jobId: string, type: string, discriminator: string): string {
  const hex = createHash("sha256")
    .update(jobId)
    .update("\0")
    .update(type)
    .update("\0")
    .update(discriminator)
    .digest("hex")
    .slice(0, 32);
  return `ev_${hex}`;
}

function reviewCounts(review: unknown): Record<string, unknown> {
  const findings = review && typeof review === "object" && Array.isArray((review as { findings?: unknown }).findings)
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

function repairData(proposal: NonNullable<EventJob["repairProposal"]>): Record<string, unknown> {
  const options = (proposal.options ?? []).flatMap((option) => {
    if (typeof option?.id !== "string" || typeof option.costUsd !== "number") return [];
    return [{ id: option.id, costUsd: option.costUsd, requiresApproval: true as const }];
  });
  return { options };
}

/**
 * Every event the current job file implies, with stable ids.
 * The writer appends the ids missing from the log. The reader adds the same
 * ids when the log is missing, behind, torn, or capped.
 */
export function deriveJobEvents(job: EventJob): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  const push = (type: string, discriminator: string, data: Record<string, unknown>) => {
    events.push({ id: eventId(job.id, type, discriminator), type, data });
  };

  push("job.started", "started", { shotCount: job.shotCount ?? job.shots?.length ?? 0 });

  const threshold = job.spendLedger?.thresholdUsd;
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    push("budget.set", canonicalJson(threshold), { thresholdUsd: threshold });
  }

  const entries = job.spendLedger?.entries ?? [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry.kind !== "string" || typeof entry.usd !== "number" || !Number.isFinite(entry.usd)) return;
    const canonicalEntry = {
      kind: entry.kind,
      usd: entry.usd,
      ...(entry.estimated ? { estimated: true } : {}),
      ...(entry.derived ? { derived: true } : {}),
      ...(entry.uncertain ? { uncertain: true } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
    const data: Record<string, unknown> = { index, kind: entry.kind, usd: entry.usd };
    if (entry.estimated) data.estimated = true;
    if (entry.derived) data.derived = true;
    if (entry.uncertain) data.uncertain = true;
    push("spend.recorded", `${index}\0${canonicalJson(canonicalEntry)}`, data);
  });

  const noteIds = (job.spendLedger?.appliedNoteIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (noteIds.length > 0) {
    const sorted = [...noteIds].sort();
    const data: Record<string, unknown> = sorted.length > 50 ? { count: sorted.length } : { noteIds: sorted.slice(0, 50) };
    push("spend.merged", sorted.join("\0"), data);
  }

  for (const shot of job.shots ?? []) {
    if (typeof shot?.index !== "number") continue;
    if (shot.status !== "completed" && shot.status !== "failed") continue;
    const type = shot.status === "completed" ? "shot.completed" : "shot.failed";
    push(type, `${shot.index}\0${shot.status}`, { index: shot.index, status: shot.status });
  }

  if (job.continuityReview !== undefined && job.continuityReview !== null) {
    push("review.recorded", createHash("sha256").update(canonicalJson(job.continuityReview)).digest("hex"), reviewCounts(job.continuityReview));
  }
  if (job.repairProposal) {
    push(
      "repair.proposed",
      createHash("sha256").update(canonicalJson(job.repairProposal)).digest("hex"),
      repairData(job.repairProposal),
    );
  }

  if (job.state === "completed" || job.state === "stopped" || job.state === "failed") {
    push(`job.${job.state}`, job.state, { state: job.state });
  }
  return events;
}

export function parseEventLog(raw: string, jobId: string): ParsedLog {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const accepted: ParsedEvent[] = [];
  let tornLines = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
      tornLines += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      tornLines += 1;
      continue;
    }
    const event = asParsedEvent(value, jobId);
    if (!event) {
      tornLines += 1;
      continue;
    }
    accepted.push(event);
  }
  const recorded = (event: ParsedEvent) => event.recordedAt ?? Number.MAX_SAFE_INTEGER;
  accepted.sort((left, right) => left.seq - right.seq
    || recorded(left) - recorded(right)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const seqCounts = new Map<number, number>();
  for (const event of accepted) seqCounts.set(event.seq, (seqCounts.get(event.seq) ?? 0) + 1);
  let seqCollisions = 0;
  for (const count of seqCounts.values()) if (count > 1) seqCollisions += count - 1;
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();
  let maxSeq = 0;
  let maxRevision: number | undefined;
  let capped = false;
  for (const event of accepted) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
    if (event.seq > maxSeq) maxSeq = event.seq;
    if (typeof event.revision === "number" && (maxRevision === undefined || event.revision > maxRevision)) {
      maxRevision = event.revision;
    }
    if (event.type === "log.capped") capped = true;
  }
  return { events, tornLines, seqCollisions, capped, maxSeq, maxRevision };
}

function asParsedEvent(value: unknown, jobId: string): ParsedEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return undefined;
  if (typeof row.id !== "string" || !/^ev_[0-9a-f]{32}$/.test(row.id)) return undefined;
  if (typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq < 1) return undefined;
  if (row.jobId !== jobId || typeof row.type !== "string" || row.type.length === 0) return undefined;
  if (row.revision !== undefined && typeof row.revision !== "number") return undefined;
  if (row.recordedAt !== undefined && typeof row.recordedAt !== "number") return undefined;
  const data = row.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  return {
    id: row.id,
    type: row.type,
    data,
    seq: row.seq,
    jobId,
    ...(typeof row.revision === "number" ? { revision: row.revision } : {}),
    ...(typeof row.recordedAt === "number" ? { recordedAt: row.recordedAt } : {}),
  };
}

function eventFingerprint(job: EventJob): string {
  const clone = structuredClone(job) as Record<string, unknown>;
  delete clone.revision;
  for (const key of ["owner", "claim"] as const) {
    const holder = clone[key];
    if (holder && typeof holder === "object") delete (holder as { heartbeatAt?: unknown }).heartbeatAt;
  }
  return createHash("sha256").update(canonicalJson(clone)).digest("hex");
}

export function writerOwns(job: EventJob): boolean {
  const owner = job.owner;
  if (owner && owner.token === processToken && owner.pid === process.pid) return true;
  const claim = job.claim;
  return Boolean(claim && claim.token === processToken && claim.pid === process.pid);
}

function reportOnce(bucket: Set<string>, jobId: string, message: string): void {
  if (bucket.has(jobId)) return;
  bucket.add(jobId);
  console.error(message);
}

function safeToken(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?").slice(0, 160);
}

function lineFor(input: {
  id: string;
  seq: number;
  jobId: string;
  type: string;
  revision?: number;
  recordedAt: number;
  data: Record<string, unknown>;
}): string {
  const body = {
    v: EVENT_LOG_VERSION,
    id: input.id,
    seq: input.seq,
    jobId: input.jobId,
    type: input.type,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    recordedAt: input.recordedAt,
    data: input.data,
  };
  let line = `${JSON.stringify(body)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
    line = `${JSON.stringify({ ...body, data: { truncated: true } })}\n`;
  }
  return line;
}

async function appendDerived(job: EventJob, jobsDir: string): Promise<void> {
  const logPath = eventLogPath(jobsDir, job.id);
  if (!logPath) {
    reportOnce(reportedSkips, job.id, `theShow: event log skipped for ${safeToken(job.id)}: invalid id`);
    return;
  }
  if (beforeAppend) await beforeAppend();
  else await runEnvAppendProbe(logPath);
  await eventFs.mkdir(resolve(jobsDir, ".events"));
  let raw = "";
  try {
    raw = await eventFs.readFile(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const parsed = parseEventLog(raw, job.id);
  if (parsed.capped) return;
  const known = new Set(parsed.events.map((event) => event.id));
  const fresh = deriveJobEvents(job).filter((event) => !known.has(event.id));
  let seq = parsed.maxSeq;
  let count = parsed.events.length;
  let bytes = Buffer.byteLength(raw);
  let needsBreak = raw.length > 0 && !raw.endsWith("\n");
  const recordedAt = Date.now();
  const cappedId = eventId(job.id, "log.capped", "capped");
  const writeLine = async (line: string) => {
    const prefix = needsBreak ? "\n" : "";
    await eventFs.appendFile(logPath, prefix + line);
    needsBreak = false;
    bytes += Buffer.byteLength(prefix) + Buffer.byteLength(line);
    count += 1;
    seq += 1;
  };
  const cappedLine = () => lineFor({
    id: cappedId,
    seq: seq + 1,
    jobId: job.id,
    type: "log.capped",
    revision: job.revision,
    recordedAt,
    data: { events: count + 1, bytes },
  });
  if (known.has(cappedId)) return;
  for (const event of fresh) {
    const prefixBytes = needsBreak ? 1 : 0;
    const real = lineFor({
      id: event.id,
      seq: seq + 1,
      jobId: job.id,
      type: event.type,
      revision: job.revision,
      recordedAt,
      data: event.data,
    });
    const marker = cappedLine();
    const roomForMarker = count + 1 <= MAX_EVENTS_PER_JOB && bytes + prefixBytes + Buffer.byteLength(marker) <= MAX_EVENT_LOG_BYTES;
    const roomForBoth = count + 2 <= MAX_EVENTS_PER_JOB
      && bytes + prefixBytes + Buffer.byteLength(real) + Buffer.byteLength(marker) <= MAX_EVENT_LOG_BYTES;
    if (!roomForBoth) {
      if (roomForMarker) await writeLine(cappedLine());
      return;
    }
    await writeLine(real);
  }
}

/**
 * Queue an append after the job file is already durable.
 * An unchanged heartbeat snapshot returns before any log read.
 * The returned promise of persistJob must not await this work.
 */
export function noteJobPersisted(job: EventJob, jobsDir: string): void {
  try {
    const fingerprint = eventFingerprint(job);
    if (fingerprints.get(job.id) === fingerprint) return;
    if (!writerOwns(job)) return;
    fingerprints.set(job.id, fingerprint);
    const run = (chains.get(job.id) ?? Promise.resolve())
      .then(() => appendDerived(job, jobsDir))
      .catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code
          ?? (err instanceof Error ? err.name : "unknown");
        reportOnce(
          reportedFailures,
          job.id,
          `theShow: event log append failed for ${safeToken(job.id)}: ${safeToken(String(code))}`,
        );
      });
    chains.set(job.id, run);
    trackWrite(run);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    reportOnce(
      reportedFailures,
      job.id,
      `theShow: event log append failed for ${safeToken(job.id)}: ${safeToken(String(code))}`,
    );
  }
}

/** Wait for this process's pending appends. Continues when the ceiling passes. */
export async function waitForJobEvents(jobId: string, timeoutMs = 2_000): Promise<void> {
  const pending = chains.get(jobId);
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bundle kill tests set THESHOW_EVENT_APPEND_PROBE to "hold" or "gap".
 * Same gate as the video stub: a shipped process with the variable set does
 * nothing unless VITEST or NODE_ENV=test is also set. Production leaves both off.
 * "hold" writes a torn tail and pauses. "gap" pauses before any log byte is written.
 */
function envAppendProbeEnabled(): boolean {
  const mode = process.env.THESHOW_EVENT_APPEND_PROBE;
  if (mode !== "hold" && mode !== "gap") return false;
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

async function runEnvAppendProbe(logPath: string): Promise<void> {
  if (!envAppendProbeEnabled()) return;
  const mode = process.env.THESHOW_EVENT_APPEND_PROBE;
  if (mode !== "hold" && mode !== "gap") return;
  if (mode === "hold") {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, "{\"partial\"", "utf8");
  }
  writeSync(2, "event-append-hold\n");
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
}

/** Test seam. Production leaves this unset. A probe may write a partial line and pause. */
export function setBeforeEventAppendProbe(next: (() => Promise<void>) | undefined): void {
  beforeAppend = next;
}

/** Test seam. Production uses node:fs. Tests simulate ENOSPC, EACCES, and ENOTDIR here. */
export function setEventFs(next: Partial<EventFs> | undefined): void {
  eventFs = next ? { ...defaultFs, ...next } : defaultFs;
}

/** True after an owning write has stored this job's event fingerprint. */
export function eventFingerprintRemembered(jobId: string): boolean {
  return fingerprints.has(jobId);
}

/** Drop in-memory skip state so a test can observe a single fresh failure. */
export function resetEventBookkeeping(jobId?: string): void {
  if (!jobId) {
    fingerprints.clear();
    reportedFailures.clear();
    reportedSkips.clear();
    return;
  }
  fingerprints.delete(jobId);
  reportedFailures.delete(jobId);
  reportedSkips.delete(jobId);
}

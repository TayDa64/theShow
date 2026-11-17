/**
 * Append-only job event log. The job file is written first. Heartbeats,
 * non-owners, and the reaper do not append. A failed append does not fail the job write.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JOBS_DIR } from "../mcp/media.ts";
import {
  canonicalJson,
  deriveJobEvents,
  eventFingerprintRemembered,
  eventId,
  eventLogPath,
  noteJobPersisted,
  parseEventLog,
  resetEventBookkeeping,
  setBeforeEventAppendProbe,
  setEventFs,
  waitForJobEvents,
  type EventJob,
} from "../mcp/jobEvents.ts";
import { readEventLog, readProductionFeed } from "../mcp/productionFeed.ts";
import {
  loadJobsFromDisk,
  persistJob,
  startOwnedJobHeartbeat,
  type SequenceJob,
} from "../mcp/server.ts";
import {
  flushJobWrites,
  hostKey,
  jobShouldStop,
  sweepOrphanTemps,
  sweepStaleReviewFrames,
  thisOwner,
} from "../mcp/runtime.ts";

const secrets = {
  token: "canary-token-9f3a",
  pid: 424242,
  host: "canary-host.internal",
  prompt: "CANARY_PROMPT_do_not_leak",
  film: "/var/canary/secret-film.mp4",
};

function film(id: string, extra: Partial<SequenceJob> = {}): SequenceJob {
  return {
    id,
    startedAt: 1_700_000_000_000,
    state: "running",
    owner: thisOwner(),
    revision: undefined,
    shotCount: 1,
    completed: 0,
    estimateUsd: 1,
    spentUsd: 0,
    shots: [],
    ...extra,
  };
}

async function logText(id: string): Promise<string> {
  return readFile(path.join(JOBS_DIR, ".events", `${id}.jsonl`), "utf8");
}

function scan(value: unknown, banned: string[], trail: string): void {
  if (typeof value === "string") {
    for (const secret of banned) {
      if (secret.length > 0) expect(value, trail).not.toContain(secret);
    }
    if (value.startsWith("/") || /^[A-Za-z]:\\/.test(value)) {
      expect(trail, value).toBe("no absolute path");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, banned, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) scan(entry, banned, `${trail}.${key}`);
  }
}

afterEach(() => {
  setBeforeEventAppendProbe(undefined);
  setEventFs(undefined);
});

describe("phase 3 event log", () => {
  it("appends each event after the job file rename, with stable ids", async () => {
    const id = `seq_p3_events_${Date.now().toString(36)}`;
    let sawFile = false;
    setBeforeEventAppendProbe(async () => {
      const raw = await readFile(path.join(JOBS_DIR, `${id}.json`), "utf8");
      expect(JSON.parse(raw).state).toBe("running");
      sawFile = true;
    });
    const running = film(id, {
      owner: { ...thisOwner(), token: secrets.token, pid: secrets.pid, host: secrets.host },
      shots: [{ index: 1, title: "A", status: "completed", prompt: secrets.prompt, costUsd: 0.2 }],
      filmPath: secrets.film,
      spendLedger: {
        version: 1,
        spentUsd: 0.2,
        pendingUsd: 0,
        thresholdUsd: 1,
        entries: [{ kind: "video", usd: 0.2, reason: secrets.prompt }],
        appliedNoteIds: ["note-b", "note-a"],
      },
      continuityReview: {
        version: 1,
        findings: [{ class: "measured" as const, topic: "wardrobe" as const, afterShot: 1, beforeShot: 2, summary: secrets.prompt }],
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
      },
      repairProposal: {
        version: 1,
        badShot: 1,
        resolution: "720p",
        options: [{ id: "retry-alone", costUsd: 1.12, fixes: [], leavesBroken: [], shotsToRender: [1], stillsToBuy: 0, requiresApproval: true }],
        executed: false,
        willRender: false,
        willSpend: false,
      },
    });
    // Owner token must match this process or nothing is appended. The canary
    // token stays on a copy that is hashed for the redaction scan below.
    running.owner = thisOwner();
    await persistJob(running);
    await flushJobWrites();
    expect(sawFile).toBe(true);
    const raw = await logText(id);
    const parsed = parseEventLog(raw, id);
    const types = parsed.events.map((event) => event.type);
    expect(types).toEqual([
      "job.started",
      "budget.set",
      "spend.recorded",
      "spend.merged",
      "shot.completed",
      "review.recorded",
      "repair.proposed",
    ]);
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16 * 1024);
    }
    const banned = [secrets.token, String(secrets.pid), secrets.host, secrets.prompt, secrets.film];
    scan(parsed.events, banned, "log");
    expect(raw).not.toContain(secrets.prompt);
    expect(raw).not.toContain(secrets.film);

    const reordered = deriveJobEvents(JSON.parse(JSON.stringify(running)) as EventJob);
    const spaced = deriveJobEvents(JSON.parse(JSON.stringify(running, null, 4)) as EventJob);
    expect(reordered.map((event) => event.id)).toEqual(parsed.events.map((event) => event.id));
    expect(spaced.map((event) => event.id)).toEqual(reordered.map((event) => event.id));
    const revised = { ...running, revision: 99, owner: { ...thisOwner(), heartbeatAt: 5 } };
    expect(deriveJobEvents(revised).map((event) => event.id)).toEqual(reordered.map((event) => event.id));
    expect(eventId(id, "job.started", "started")).toBe(parsed.events[0]?.id);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("numbers seq from the log, including after the in-memory chain is gone", async () => {
    const id = `seq_p3_seq_${Date.now().toString(36)}`;
    await persistJob(film(id));
    await flushJobWrites();
    resetEventBookkeeping(id);
    const next = film(id, {
      state: "completed",
      finishedAt: 1_700_000_000_100,
      shots: [{ index: 1, title: "A", status: "completed" }],
    });
    next.owner = thisOwner();
    await persistJob(next);
    await flushJobWrites();
    const parsed = parseEventLog(await logText(id), id);
    expect(parsed.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(parsed.seqCollisions).toBe(0);
  });

  it("lets only the owner append", async () => {
    const id = `seq_p3_owner_${Date.now().toString(36)}`;
    const foreign = film(id, {
      owner: { pid: 999_999, token: "not-this-process", host: "other", heartbeatAt: 1 },
    });
    await persistJob(foreign);
    await flushJobWrites();
    await expect(stat(path.join(JOBS_DIR, ".events", `${id}.jsonl`))).rejects.toThrow();
  });

  it("does not let the reaper append", async () => {
    const id = `seq_p3_reap_${Date.now().toString(36)}`;
    const body = film(id, {
      state: "running",
      owner: { pid: 999_999, token: "dead-owner", host: hostKey() ? "remote-host" : "remote-host", heartbeatAt: 1 },
    });
    body.owner = { pid: 999_999, token: "dead-owner", host: "somewhere-else", heartbeatAt: 1 };
    expect(jobShouldStop(body.owner)).toBe(true);
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(body));
    const logPath = path.join(JOBS_DIR, ".events", `${id}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "");
    const before = await readFile(logPath);
    await loadJobsFromDisk();
    expect(await readFile(logPath)).toEqual(before);
    const disk = JSON.parse(await readFile(path.join(JOBS_DIR, `${id}.json`), "utf8")) as { state: string };
    expect(disk.state).toBe("stopped");
  });

  it("keeps the log byte-identical across heartbeats", async () => {
    const previous = process.env.THESHOW_JOB_HEARTBEAT_MS;
    process.env.THESHOW_JOB_HEARTBEAT_MS = "200";
    const runningId = `seq_p3_beat_run_${Date.now().toString(36)}`;
    const claimedId = `seq_p3_beat_claim_${Date.now().toString(36)}`;
    try {
      await persistJob(film(runningId));
      await persistJob(film(claimedId, { state: "completed", finishedAt: 10, claim: thisOwner() }));
      await flushJobWrites();
      await loadJobsFromDisk();
      const beforeRun = await logText(runningId);
      const beforeClaim = await logText(claimedId);
      const stop = startOwnedJobHeartbeat();
      const started = Date.now();
      const revision = async (id: string) => {
        const body = JSON.parse(await readFile(path.join(JOBS_DIR, `${id}.json`), "utf8")) as { revision?: number };
        return body.revision ?? 0;
      };
      const baseRun = await revision(runningId);
      const baseClaim = await revision(claimedId);
      while (Date.now() - started < 8_000) {
        if ((await revision(runningId)) >= baseRun + 20 && (await revision(claimedId)) >= baseClaim + 20) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stop();
      await flushJobWrites();
      expect(await revision(runningId)).toBeGreaterThanOrEqual(baseRun + 20);
      expect(await revision(claimedId)).toBeGreaterThanOrEqual(baseClaim + 20);
      expect(await logText(runningId)).toBe(beforeRun);
      expect(await logText(claimedId)).toBe(beforeClaim);
    } finally {
      if (previous === undefined) delete process.env.THESHOW_JOB_HEARTBEAT_MS;
      else process.env.THESHOW_JOB_HEARTBEAT_MS = previous;
    }
  }, 15_000);

  it("resolves persistJob while an append probe never resolves", async () => {
    const id = `seq_p3_hang_${Date.now().toString(36)}`;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setBeforeEventAppendProbe(() => gate);
    const started = Date.now();
    await persistJob(film(id));
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    await waitForJobEvents(id, 1_000);
  });

  it("logs one stderr line and still returns the job write when the append fails", async () => {
    const id = `seq_p3_enospc_${Date.now().toString(36)}`;
    const errors: string[] = [];
    const stderr = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    setEventFs({
      appendFile: async () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    });
    try {
      await persistJob(film(id));
      await flushJobWrites();
      const changed = film(id, { state: "completed", finishedAt: 2, shots: [{ index: 1, title: "A", status: "failed" }] });
      changed.owner = thisOwner();
      await persistJob(changed);
      await flushJobWrites();
    } finally {
      console.error = stderr;
      setEventFs(undefined);
    }
    const logged = errors.filter((line) => line.includes("event log append failed"));
    expect(logged).toEqual([`theShow: event log append failed for ${id}: ENOSPC`]);
    expect(logged.join("\n")).not.toMatch(/stdout/);
    const disk = JSON.parse(await readFile(path.join(JOBS_DIR, `${id}.json`), "utf8")) as { state: string };
    expect(disk.state).toBe("completed");
  });

  it("prefixes a torn line and never rewrites earlier bytes", async () => {
    const id = `seq_p3_torn_${Date.now().toString(36)}`;
    const logPath = eventLogPath(JOBS_DIR, id);
    expect(logPath).toBeTruthy();
    await mkdir(path.dirname(logPath!), { recursive: true });
    const torn = "{\"v\":1,\"id\":\"ev_not_a_full_line\"";
    await writeFile(logPath!, torn);
    await noteJobPersisted(film(id), JOBS_DIR);
    await flushJobWrites();
    const next = await readFile(logPath!);
    expect(next.subarray(0, Buffer.byteLength(torn)).toString("utf8")).toBe(torn);
    const text = next.toString("utf8");
    expect(text.startsWith(`${torn}\n`)).toBe(true);
    const parsed = parseEventLog(text, id);
    expect(parsed.tornLines).toBe(1);
    expect(parsed.events.map((event) => event.type)).toContain("job.started");
  });

  it("reconciles a missing log to the same ids and ignores an orphan log", async () => {
    const id = `seq_p3_legacy_${Date.now().toString(36)}`;
    const body = film(id, {
      state: "completed",
      finishedAt: 50,
      shots: [{ index: 1, title: "A", status: "completed" }],
    });
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(body));
    const orphan = path.join(JOBS_DIR, ".events", "seq_p3_orphan_only.jsonl");
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, "{\"v\":1}\n");
    const before = await readFile(orphan);
    const feed = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 50 });
    if ("refused" in feed) throw new Error(feed.reason);
    const job = feed.jobs.find((entry) => entry.jobId === id);
    expect(job?.log.present).toBe(false);
    expect(job?.log.behind).toBe(true);
    expect(feed.events.filter((event) => event.jobId === id).every((event) => event.source === "reconciled")).toBe(true);
    expect(feed.events.filter((event) => event.jobId === id).map((event) => event.id).sort())
      .toEqual(deriveJobEvents(body).map((event) => event.id).sort());
    expect(feed.jobs.some((entry) => entry.jobId === "seq_p3_orphan_only")).toBe(false);
    expect(await readFile(orphan)).toEqual(before);
  });

  it("caps at 2000 events and at 1 MiB, then reconciles the rest", async () => {
    const id = `seq_p3_cap_${Date.now().toString(36)}`;
    const shots = Array.from({ length: 2_500 }, (_, index) => ({
      index: index + 1,
      title: `S${index}`,
      status: "failed" as const,
    }));
    await persistJob(film(id, { state: "failed", finishedAt: 9, shotCount: shots.length, shots }));
    await flushJobWrites();
    const raw = await logText(id);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1024 * 1024);
    const parsed = parseEventLog(raw, id);
    expect(parsed.events.filter((event) => event.type === "log.capped")).toHaveLength(1);
    expect(parsed.events.length).toBeLessThanOrEqual(2_000);
    let cursor: string | undefined;
    let reconciled = false;
    let capped = false;
    for (let page = 0; page < 80 && !reconciled; page += 1) {
      const feed = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 50, cursor });
      if ("refused" in feed) throw new Error(feed.reason);
      capped = feed.jobs[0]?.log.capped === true;
      reconciled = feed.events.some((event) => event.source === "reconciled");
      if (!feed.truncated) break;
      cursor = feed.cursor;
    }
    expect(capped).toBe(true);
    expect(reconciled).toBe(true);

    const bytesId = `seq_p3_bytes_${Date.now().toString(36)}`;
    const logPath = eventLogPath(JOBS_DIR, bytesId)!;
    await mkdir(path.dirname(logPath), { recursive: true });
    let seq = 1;
    let filled = "";
    while (Buffer.byteLength(filled) < 1024 * 1024 - 8_000 && seq < 800) {
      const idHex = createHash("sha256").update(`pad-${seq}`).digest("hex").slice(0, 32);
      filled += `${JSON.stringify({
        v: 1,
        id: `ev_${idHex}`,
        seq,
        jobId: bytesId,
        type: "job.started",
        recordedAt: seq,
        data: { pad: "x".repeat(80) },
      })}\n`;
      seq += 1;
    }
    const target = 1024 * 1024 - 230;
    let text = filled;
    while (Buffer.byteLength(text) > target) {
      const cut = text.lastIndexOf("\n", text.length - 2);
      text = text.slice(0, cut + 1);
    }
    const gap = target - Buffer.byteLength(text);
    if (gap > 1) text += `${"x".repeat(gap - 1)}\n`;
    expect(Buffer.byteLength(text)).toBe(target);
    expect(text.endsWith("\n")).toBe(true);
    await writeFile(logPath, text);
    await noteJobPersisted(film(bytesId, { state: "completed", finishedAt: 3, shots: [{ index: 1, title: "A", status: "completed" }] }), JOBS_DIR);
    await flushJobWrites();
    const cappedBytes = await readFile(logPath);
    expect(cappedBytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const body = parseEventLog(cappedBytes.toString("utf8"), bytesId);
    expect(body.events.filter((event) => event.type === "log.capped")).toHaveLength(1);
  });

  it("dedupes a repeated event id and keeps the first sequence number", () => {
    const id = "seq_p3_dedupe";
    const line = (seq: number) => JSON.stringify({
      v: 1,
      id: `ev_${"ab".repeat(16)}`,
      seq,
      jobId: id,
      type: "job.started",
      recordedAt: seq,
      data: { state: "running" },
    });
    const parsed = parseEventLog(`${line(2)}\n${line(1)}\n`, id);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.seq).toBe(1);
    expect(parsed.seqCollisions).toBe(0);
    const sameSeq = parseEventLog(`${line(4)}\n${line(4)}\n`, id);
    expect(sameSeq.events).toHaveLength(1);
    expect(sameSeq.seqCollisions).toBe(1);
  });

  it("does not remember a fingerprint until this process owns the job", async () => {
    const id = `seq_p3_fp_${Date.now().toString(36)}`;
    const foreign = film(id, {
      state: "completed",
      finishedAt: 2,
      owner: { pid: 1, token: "other", host: "other-host", heartbeatAt: 1 },
      shots: [{ index: 1, title: "A", status: "completed" }],
    });
    await persistJob(foreign);
    await flushJobWrites();
    expect(eventFingerprintRemembered(id)).toBe(false);
    await expect(readFile(path.join(JOBS_DIR, ".events", `${id}.jsonl`))).rejects.toThrow();
    await persistJob(film(id, {
      state: "completed",
      finishedAt: 2,
      shots: [{ index: 1, title: "A", status: "completed" }],
    }));
    await flushJobWrites();
    expect(eventFingerprintRemembered(id)).toBe(true);
    const parsed = parseEventLog(await logText(id), id);
    expect(parsed.events.some((event) => event.type === "shot.completed")).toBe(true);
  });

  it("leaves .events untouched by the sweeps and the reaper, and confines job ids", async () => {
    const id = `seq_p3_sweep_${Date.now().toString(36)}`;
    const logPath = path.join(JOBS_DIR, ".events", `${id}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "{\"kept\":true}\n");
    const before = await readFile(logPath);
    await writeFile(path.join(JOBS_DIR, `orphan.${process.pid}.${hostKey()}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`), "temp");
    await loadJobsFromDisk();
    await sweepOrphanTemps(JOBS_DIR);
    await sweepStaleReviewFrames(JOBS_DIR);
    expect(await readFile(logPath)).toEqual(before);

    const outside = await mkdir(path.join(tmpdir(), `theshow-p3-outside-${Date.now().toString(36)}`), { recursive: true }).then(() => undefined);
    expect(outside).toBeUndefined();
    const home = path.join(tmpdir(), `theshow-p3-confine-${Date.now().toString(36)}`);
    await mkdir(home, { recursive: true });
    for (const bad of ["../x", "/etc/passwd", "a/b", "..", "seq with space"]) {
      expect(eventLogPath(home, bad)).toBeUndefined();
      await noteJobPersisted({ id: bad, state: "running", owner: thisOwner() }, home);
      await flushJobWrites();
    }
    const listing = await readEventLog(home, "seq_safe_name").then((log) => log.present);
    expect(listing).toBe(false);
    const feed = await readProductionFeed({ jobsDir: home, jobId: "../x" });
    expect(feed).toEqual({ refused: true, reason: "jobId is not confined to the jobs directory" });
  });
});

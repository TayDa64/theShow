/**
 * Phase 1 job notes survive a crash and a second process.
 * Each test uses its own jobs directory. The parent process's JOBS_DIR is not read.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostKey, exclusiveTempPath, sweepOrphanTemps, sweepStaleReviewFrames } from "../mcp/runtime.ts";
import { noteReportedSpend, recordedSpendUsd, type SequenceJob } from "../mcp/server.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "tests/mcp-multi-child.ts");

function film(id: string): Record<string, unknown> {
  return {
    id,
    startedAt: 1,
    state: "completed",
    shotCount: 1,
    completed: 1,
    estimateUsd: 1.12,
    spentUsd: 1.12,
    filmPath: `/keep/${id}.mp4`,
    shots: [{
      index: 1,
      title: "Old",
      status: "completed",
      localPath: `/keep/${id}.mp4`,
      costUsd: 1.12,
      prompt: "A lantern.",
      durationSeconds: 8,
    }],
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      fadeDuration: 0,
      assemble: true,
      pin: "start",
    },
  };
}

async function jobsDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "theshow-home-"));
  const jobs = path.join(root, "jobs");
  await mkdir(jobs, { recursive: true });
  return jobs;
}

function childEnv(jobs: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.dirname(jobs),
    THESHOW_JOBS_DIR: jobs,
    THESHOW_OUTPUT_DIR: path.join(path.dirname(jobs), "media"),
    GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
    THESHOW_FORBID_HOME_AUTH: "1",
    ...extra,
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function runChild(jobs: string, args: string[], extra: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string; pid: number | undefined; kill: () => void }> {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], {
    cwd: ROOT,
    env: childEnv(jobs, extra),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout,
      stderr,
      pid: child.pid,
      kill: () => child.kill("SIGKILL"),
    }));
  });
}

describe("phase 1 recovery without a bot", () => {
  it("loads an old job that has none of the new fields", async () => {
    const jobs = await jobsDir();
    process.env.THESHOW_JOBS_DIR = path.join(tmpdir(), "stale-jobs-that-are-not-used");
    const id = "seq_phase1_old_job";
    const original = JSON.stringify(film(id));
    await writeFile(path.join(jobs, `${id}.json`), original);
    const child = await runChild(jobs, ["show-job", id]);
    expect(child.status, child.stderr).toBe(0);
    const body = JSON.parse(child.stdout) as { state: string; pin: string; reviewVersion: number | null; shots: number };
    expect(body.state).toBe("completed");
    expect(body.pin).toBe("start");
    expect(body.shots).toBe(1);
    expect(body.reviewVersion).toBeNull();
    expect(await readFile(path.join(jobs, `${id}.json`), "utf8")).toBe(original);
  });

  it("keeps the previous job when a review write is killed before rename", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_kill_review";
    const original = JSON.stringify(film(id));
    await writeFile(path.join(jobs, `${id}.json`), original);
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, "annotate-review", id], {
      cwd: ROOT,
      env: childEnv(jobs, { THESHOW_PAUSE_BEFORE_RENAME: "1" }),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not pause\n${stdout}`)), 10_000);
      child.stdout.on("data", () => {
        if (stdout.includes("paused-before-rename")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    const raw = await readFile(path.join(jobs, `${id}.json`), "utf8");
    expect(JSON.parse(raw).continuityReview).toBeUndefined();
    expect(JSON.parse(raw).state).toBe("completed");
    const leftovers = (await readdir(jobs)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers.length).toBeGreaterThan(0);
    const sweeper = await runChild(jobs, ["show-job", id]);
    expect(sweeper.status, sweeper.stderr).toBe(0);
    const after = (await readdir(jobs)).filter((name) => name.endsWith(".tmp"));
    expect(after).toEqual([]);
  }, 20_000);

  it("keeps both annotations when two processes write the same film", async () => {
    const jobs = await jobsDir();
    const gate = await mkdtemp(path.join(tmpdir(), "theshow-claim-gate-"));
    const ids = Array.from({ length: 60 }, (_, round) => `seq_phase1_race_${round}`);
    for (const id of ids) {
      await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    }
    const [review, repair] = await Promise.all([
      runChild(jobs, ["annotate-batch", "review", ...ids], { THESHOW_CLAIM_GATE: gate }),
      runChild(jobs, ["annotate-after-pause", gate, "repair", ...ids]),
    ]);
    expect(review.status, `${review.stderr}\n${review.stdout}`).toBe(0);
    expect(repair.status, `${repair.stderr}\n${repair.stdout}`).toBe(0);
    expect(review.stdout).toContain("persisted");
    expect(repair.stdout).toContain("persisted");
    for (const id of ids) {
      const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
        continuityReview?: { version?: number };
        repairProposal?: { version?: number };
        filmPath?: string;
      };
      expect(saved.continuityReview?.version, id).toBe(1);
      expect(saved.repairProposal?.version, id).toBe(1);
      expect(saved.filmPath).toBe(`/keep/${id}.mp4`);
    }
  }, 60_000);

  it("does not write a review onto a film that is still rendering", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_running_guard";
    const body = film(id);
    body.state = "running";
    const original = JSON.stringify(body);
    await writeFile(path.join(jobs, `${id}.json`), original);
    const child = await runChild(jobs, ["refuse-running", id]);
    expect(child.status, child.stderr).toBe(0);
    const saved = JSON.parse(child.stdout) as { ok: boolean; message: string };
    expect(saved.ok).toBe(false);
    expect(saved.message).toMatch(/rendering/);
    expect(saved.message).not.toMatch(/already running/);
    const after = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { state: string; continuityReview?: unknown };
    expect(after.state).toBe("running");
    expect(after.continuityReview).toBeUndefined();
  });

  it("says to retry when another process holds the claim", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_claim_held";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const holder = spawn(process.execPath, ["--import", "tsx", CHILD, "claim", id], {
      cwd: ROOT,
      env: childEnv(jobs),
    });
    let held = "";
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk: string) => { held += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`claim did not answer\n${held}`)), 10_000);
      holder.stdout.on("data", () => {
        if (held.includes("\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const once = await runChild(jobs, ["annotate-once", id]);
    holder.kill("SIGKILL");
    expect(once.status, once.stderr).toBe(0);
    const saved = JSON.parse(once.stdout) as { ok: boolean; message: string };
    expect(saved.ok).toBe(false);
    expect(saved.message).toMatch(/retry shortly/);
    expect(saved.message).not.toMatch(/already running/);
  });

  it("leaves another host's young temp file alone and removes a dead local one and an old foreign one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-temps-"));
    const foreign = path.join(dir, `job.424242.${"ab".repeat(32)}.${"a".repeat(8)}.tmp`);
    const oldForeign = path.join(dir, `job.7.${"cd".repeat(32)}.${"d".repeat(8)}.tmp`);
    const dead = path.join(dir, `job.999999.${hostKey()}.${"b".repeat(8)}.tmp`);
    await writeFile(foreign, "foreign");
    await writeFile(oldForeign, "old");
    await writeFile(dead, "dead");
    const past = new Date(Date.now() - 16 * 60 * 1000);
    await utimes(oldForeign, past, past);
    await sweepOrphanTemps(dir);
    const names = await readdir(dir);
    expect(names.some((name) => name.includes("424242"))).toBe(true);
    expect(names.some((name) => name.includes("999999"))).toBe(false);
    expect(names.some((name) => name.startsWith("job.7."))).toBe(false);
  });

  it("sweeps a dead review-frame directory and an old foreign one, and keeps a young foreign one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-frames-"));
    const dead = path.join(dir, `.review-frames-999999-${hostKey()}-aaaaaa`);
    const youngForeign = path.join(dir, `.review-frames-1-${"ab".repeat(32)}-bbbbbb`);
    const oldForeign = path.join(dir, `.review-frames-1-${"cd".repeat(32)}-cccccc`);
    await mkdir(dead);
    await mkdir(youngForeign);
    await mkdir(oldForeign);
    const past = new Date(Date.now() - 16 * 60 * 1000);
    await utimes(oldForeign, past, past);
    await sweepStaleReviewFrames(dir);
    const names = await readdir(dir);
    expect(names.some((name) => name.includes("999999"))).toBe(false);
    expect(names.some((name) => name.includes("bbbbbb"))).toBe(true);
    expect(names.some((name) => name.includes("cccccc"))).toBe(false);
  });

  it("sweeps a stale review-frame directory when the server loads jobs", async () => {
    const jobs = await jobsDir();
    const stale = path.join(jobs, `.review-frames-999999-${hostKey()}-m25sweep`);
    await mkdir(stale);
    const child = await runChild(jobs, ["load-jobs"]);
    expect(child.status, child.stderr).toBe(0);
    const names = await readdir(jobs);
    expect(names.some((name) => name.startsWith(".review-frames-"))).toBe(false);
  });

  it("names a claim temp with the host hash so a dead local writer is swept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-claim-tmp-"));
    const named = exclusiveTempPath(path.join(dir, "film.claim"));
    expect(named).toContain(`.${hostKey()}.`);
    const dead = path.join(dir, `film.claim.999999.${hostKey()}.${"a".repeat(8)}-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`);
    const foreign = path.join(dir, `film.claim.999999.${"ab".repeat(32)}.${"b".repeat(8)}-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`);
    await writeFile(dead, "dead");
    await writeFile(foreign, "foreign");
    await sweepOrphanTemps(dir);
    const names = await readdir(dir);
    expect(names.some((name) => name.includes("999999") && name.includes(hostKey()))).toBe(false);
    expect(names.some((name) => name.includes("ab".repeat(16)))).toBe(true);
  });

  it("queues a budget while another process is rendering and applies it on the next claim", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_deferred_budget";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const holder = spawn(process.execPath, ["--import", "tsx", CHILD, "hold-running", id], {
      cwd: ROOT,
      env: childEnv(jobs),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let held = "";
    holder.stdout?.setEncoding("utf8");
    holder.stdout?.on("data", (chunk: string) => { held += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`holder did not answer\n${held}`)), 10_000);
      holder.stdout?.on("data", () => {
        if (held.includes("holding")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const estimate = await runChild(jobs, ["call-tool", "generate_controlled_clip", JSON.stringify({
      prompt: "A lantern.", jobId: id, budgetUsd: 4, confirm: false,
    })]);
    holder.kill("SIGKILL");
    expect(estimate.status, estimate.stderr).toBe(0);
    const body = JSON.parse(estimate.stdout) as { budgetNote?: { deferred?: boolean; queued?: boolean; reason?: string } };
    expect(body.budgetNote?.deferred).toBe(true);
    expect(body.budgetNote?.queued).toBe(true);
    expect(body.budgetNote?.reason).toMatch(/rendering/);
    const during = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { spendLedger?: { thresholdUsd?: number } };
    expect(during.spendLedger?.thresholdUsd).toBeUndefined();
    const merged = await runChild(jobs, ["annotate-review", id]);
    expect(merged.status, merged.stderr).toBe(0);
    const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
      continuityReview?: { version?: number };
      spendLedger?: { thresholdUsd?: number };
    };
    expect(saved.continuityReview?.version).toBe(1);
    expect(saved.spendLedger?.thresholdUsd).toBe(4);
  }, 30_000);

  it("counts each queued note once after a restart, including a crash around the merge", async () => {
    const pauses = ["before-merge", "before-rename", "before-delete"] as const;
    for (const pause of pauses) {
      const jobs = await jobsDir();
      const id = `seq_phase1_journal_${pause}`;
      await writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
        ...film(id),
        estimateUsd: 0,
        spentUsd: 0,
        shots: [{ index: 1, title: "Old", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
      }));
      const seeded = await runChild(jobs, ["seed-notes", id, "0.14", "0.28", "0.42"]);
      expect(seeded.status, seeded.stderr).toBe(0);
      const child = spawn(process.execPath, ["--import", "tsx", CHILD, "drain-owned", id], {
        cwd: ROOT,
        env: childEnv(jobs, { THESHOW_JOURNAL_PAUSE: pause }),
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${pause} did not pause\n${stdout}`)), 15_000);
        child.stdout.on("data", () => {
          if (stdout.includes("paused")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("close", resolve));
      const first = await runChild(jobs, ["drain-owned", id]);
      const second = await runChild(jobs, ["drain-owned", id]);
      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
        spendLedger?: { spentUsd: number; entries?: unknown[]; appliedNoteIds?: string[] };
      };
      expect(saved.spendLedger?.spentUsd, pause).toBe(0.84);
      expect(saved.spendLedger?.entries, pause).toHaveLength(3);
      expect(saved.spendLedger?.appliedNoteIds, pause).toHaveLength(3);
      const left = await readdir(path.join(jobs, ".spend-journal", id)).catch(() => [] as string[]);
      expect(left.filter((name) => name.endsWith(".json")), pause).toEqual([]);
    }
  }, 40_000);

  it("keeps a queued total exact across two claims and drops a torn note", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_journal_exact";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
      ...film(id),
      estimateUsd: 0,
      spentUsd: 0,
      shots: [{ index: 1, title: "Old", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
    }));
    const seeded = await runChild(jobs, ["seed-notes", id, "0.14", "0.28", "0.42"]);
    expect(seeded.status, seeded.stderr).toBe(0);
    await writeFile(path.join(jobs, ".spend-journal", id, "0000000000000000-torn.json"), "{");
    const first = await runChild(jobs, ["drain-owned", id]);
    const second = await runChild(jobs, ["drain-owned", id]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
      spendLedger?: { spentUsd: number; entries?: unknown[] };
    };
    expect(saved.spendLedger?.spentUsd).toBe(0.84);
    expect(saved.spendLedger?.entries).toHaveLength(3);
    const left = await readdir(path.join(jobs, ".spend-journal", id)).catch(() => [] as string[]);
    expect(left.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(left.some((name) => name.includes("torn"))).toBe(false);
  });

  it("names a deferred extend spend and a deferred budget on a cost refusal", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_extend_deferred";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const holder = spawn(process.execPath, ["--import", "tsx", CHILD, "hold-running", id], {
      cwd: ROOT,
      env: childEnv(jobs),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let held = "";
    holder.stdout?.setEncoding("utf8");
    holder.stdout?.on("data", (chunk: string) => { held += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`holder did not answer\n${held}`)), 10_000);
      holder.stdout?.on("data", () => {
        if (held.includes("holding")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const submitted = await runChild(jobs, ["call-tool", "extend_clip", JSON.stringify({
      videoUrl: "https://example.test/clip.mp4",
      prompt: "A lantern.",
      confirm: true,
      overrideValidation: true,
      waitForCompletion: false,
      jobId: id,
    })], { THESHOW_MOCK_PAID: "1" });
    const refused = await runChild(jobs, ["call-tool", "generate_controlled_clip", JSON.stringify({
      prompt: "A lantern.",
      confirm: true,
      approvedUsd: 0.14,
      budgetUsd: 2,
      jobId: id,
    })]);
    const stillRefused = await runChild(jobs, ["call-tool", "generate_still", JSON.stringify({
      prompt: "A lantern.",
      confirm: true,
      approvedUsd: 0.02,
      budgetUsd: 2,
      jobId: id,
    })]);
    holder.kill("SIGKILL");
    expect(submitted.status, submitted.stderr).toBe(0);
    expect(refused.status, refused.stderr).toBe(0);
    expect(stillRefused.status, stillRefused.stderr).toBe(0);
    const submittedBody = JSON.parse(submitted.stdout) as { status?: string; spendNote?: { deferred?: boolean; queued?: boolean } };
    const refusedBody = JSON.parse(refused.stdout) as { action?: string; budgetNote?: { deferred?: boolean } };
    const stillBody = JSON.parse(stillRefused.stdout) as { action?: string; budgetNote?: { deferred?: boolean } };
    expect(submittedBody.status).toBe("submitted");
    expect(submittedBody.spendNote?.deferred).toBe(true);
    expect(submittedBody.spendNote?.queued).toBe(true);
    expect(refusedBody.action).toBe("refused");
    expect(refusedBody.budgetNote?.deferred).toBe(true);
    expect(stillBody.action).toBe("refused");
    expect(stillBody.budgetNote?.deferred).toBe(true);
  }, 30_000);

  it("does not let a clip, still, or extend estimate rewrite a film another process is rendering", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_budget_running";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const holder = spawn(process.execPath, ["--import", "tsx", CHILD, "hold-running", id], {
      cwd: ROOT,
      env: childEnv(jobs),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let held = "";
    holder.stdout?.setEncoding("utf8");
    holder.stdout?.on("data", (chunk: string) => { held += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`holder did not answer\n${held}`)), 10_000);
      holder.stdout?.on("data", () => {
        if (held.includes("holding")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const estimates = await Promise.all([
      runChild(jobs, ["call-tool", "generate_controlled_clip", JSON.stringify({
        prompt: "A lantern.", jobId: id, budgetUsd: 2, confirm: false,
      })]),
      runChild(jobs, ["call-tool", "generate_still", JSON.stringify({
        prompt: "A lantern.", jobId: id, budgetUsd: 2, confirm: false,
      })]),
      runChild(jobs, ["call-tool", "extend_clip", JSON.stringify({
        videoUrl: "https://example.test/clip.mp4", prompt: "A lantern.", jobId: id, budgetUsd: 2, confirm: false,
      })]),
    ]);
    for (const estimate of estimates) expect(estimate.status, estimate.stderr).toBe(0);
    expect(holder.exitCode).toBe(null);
    const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
      state: string;
      filmPath?: string;
      spendLedger?: { thresholdUsd?: number };
    };
    expect(saved.state).toBe("running");
    expect(saved.filmPath).toBe(`/keep/${id}.mp4`);
    expect(saved.spendLedger?.thresholdUsd).toBeUndefined();
    holder.kill("SIGKILL");
  }, 30_000);

  it("keeps a review when a clip estimate and a paid clip record a budget on the same film", async () => {
    const jobs = await jobsDir();
    const id = "seq_phase1_budget_race";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const paid = {
      prompt: "A lantern.",
      jobId: id,
      budgetUsd: 3,
      confirm: true,
      overrideValidation: true,
      waitForCompletion: false,
      durationSeconds: 1,
    };
    const [review, clip, still, extension] = await Promise.all([
      runChild(jobs, ["annotate-review", id]),
      runChild(jobs, ["call-tool", "generate_controlled_clip", JSON.stringify(paid)], { THESHOW_MOCK_PAID: "1" }),
      runChild(jobs, ["call-tool", "generate_still", JSON.stringify({
        prompt: "A lantern.", jobId: id, confirm: true, overrideValidation: true,
      })], { THESHOW_MOCK_PAID: "1" }),
      runChild(jobs, ["call-tool", "extend_clip", JSON.stringify({
        videoUrl: "https://example.test/clip.mp4",
        prompt: "A lantern.",
        jobId: id,
        confirm: true,
        overrideValidation: true,
        waitForCompletion: false,
      })], { THESHOW_MOCK_PAID: "1" }),
    ]);
    expect(review.status, review.stderr).toBe(0);
    expect(clip.status, clip.stderr).toBe(0);
    expect(still.status, still.stderr).toBe(0);
    expect(extension.status, extension.stderr).toBe(0);
    const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
      continuityReview?: { version?: number };
      filmPath?: string;
      spendLedger?: { entries?: Array<{ kind: string; estimated?: boolean }> };
    };
    expect(saved.continuityReview?.version).toBe(1);
    expect(saved.filmPath).toBe(`/keep/${id}.mp4`);
    const kinds = saved.spendLedger?.entries?.map((entry) => entry.kind) ?? [];
    expect(kinds).toEqual(expect.arrayContaining(["video", "still", "extend"]));
    expect(saved.spendLedger?.entries?.filter((entry) => entry.kind !== "video" || entry.estimated).length).toBeGreaterThan(0);
  }, 30_000);

  it("adds a reported board cost on top of recorded shot costs", () => {
    const job = {
      id: "seq_spend",
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1.12,
      spentUsd: 0,
      shots: [{ index: 1, title: "Old", status: "completed", costUsd: 1.12 }],
    } as SequenceJob;
    expect(recordedSpendUsd(job)).toBe(1.12);
    noteReportedSpend(job, "board", 0.08);
    expect(recordedSpendUsd(job)).toBe(1.2);
    expect(job.spendLedger?.entries?.map((entry) => entry.kind)).toEqual(["video", "board"]);
  });
});

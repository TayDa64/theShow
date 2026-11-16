/**
 * Phase 1 job notes survive a crash and a second process.
 * Each test uses its own jobs directory. The parent process's JOBS_DIR is not read.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processHost, sweepOrphanTemps } from "../mcp/runtime.ts";
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
    process.env.THESHOW_JOBS_DIR = path.join(tmpdir(), "another-stale-jobs-dir");
    for (let round = 0; round < 60; round += 1) {
      const id = `seq_phase1_race_${round}`;
      await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
      const [review, repair] = await Promise.all([
        runChild(jobs, ["annotate-review", id]),
        runChild(jobs, ["annotate-repair", id]),
      ]);
      expect(review.status, review.stderr).toBe(0);
      expect(repair.status, repair.stderr).toBe(0);
      expect(review.stdout).toContain("persisted");
      expect(repair.stdout).toContain("persisted");
      const saved = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as {
        continuityReview?: { version?: number };
        repairProposal?: { version?: number };
        filmPath?: string;
      };
      expect(saved.continuityReview?.version, `round ${round}`).toBe(1);
      expect(saved.repairProposal?.version, `round ${round}`).toBe(1);
      expect(saved.filmPath).toBe(`/keep/${id}.mp4`);
    }
  }, 180_000);

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

  it("leaves another host's young temp file alone and removes a dead local one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-temps-"));
    const slug = processHost.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 32) || "host";
    const foreign = path.join(dir, `job.424242.otherhost.${"a".repeat(8)}.tmp`);
    const dead = path.join(dir, `job.999999.${slug}.${"b".repeat(8)}.tmp`);
    await writeFile(foreign, "foreign");
    await writeFile(dead, "dead");
    await sweepOrphanTemps(dir);
    const names = await readdir(dir);
    expect(names.some((name) => name.includes("otherhost"))).toBe(true);
    expect(names.some((name) => name.includes("999999"))).toBe(false);
  });

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

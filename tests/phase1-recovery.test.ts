/**
 * Phase 1 state survives a restart with no assistant process watching.
 * Children only read the job file. They do not render.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessBudget } from "../mcp/costGate.ts";
import { reviewContinuity } from "../mcp/continuityReview.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { buildDependencyGraph, proposeRepair } from "../mcp/repairPlan.ts";
import { thisOwner } from "../mcp/runtime.ts";
import {
  loadJobsFromDisk,
  persistJob,
  readPersistedJob,
  rememberedJob,
  saveJobAnnotation,
  type SequenceJob,
} from "../mcp/server.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "tests/mcp-multi-child.ts");

function film(id: string, extra: Partial<SequenceJob> = {}): SequenceJob {
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
    ...extra,
  };
}

function showJob(id: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, "show-job", id], {
      cwd: ROOT,
      env: {
        ...process.env,
        THESHOW_JOBS_DIR: JOBS_DIR,
        GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
        THESHOW_FORBID_HOME_AUTH: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("phase 1 recovery without a bot", () => {
  it("loads an old job that has none of the new fields", async () => {
    const id = "seq_phase1_old_job";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    await loadJobsFromDisk();
    const loaded = rememberedJob(id);
    expect(loaded?.state).toBe("completed");
    expect(loaded?.settings?.pin).toBe("start");
    expect(loaded?.shots[0]?.localPath).toBe(`/keep/${id}.mp4`);
    expect(loaded?.spentUsd).toBe(1.12);
    expect(loaded?.continuityReview).toBeUndefined();
    expect(loaded?.spendLedger).toBeUndefined();
    expect(loaded?.dependencies).toBeUndefined();
    expect(loaded?.repairProposal).toBeUndefined();
  });

  it("keeps the previous job when a review write does not finish", async () => {
    const id = "seq_phase1_partial_review";
    const file = path.join(JOBS_DIR, `${id}.json`);
    await writeFile(file, JSON.stringify(film(id)));
    await writeFile(`${file}.${process.pid}.interrupted.tmp`, "{ \"continuityReview\": { \"version\": 1");
    const loaded = await readPersistedJob(id);
    expect(loaded?.continuityReview).toBeUndefined();
    expect(loaded?.repairProposal).toBeUndefined();
    expect(loaded?.state).toBe("completed");
    expect(loaded?.filmPath).toBe(`/keep/${id}.mp4`);
  });

  it("keeps the previous job when a repair proposal write does not finish", async () => {
    const id = "seq_phase1_partial_repair";
    const file = path.join(JOBS_DIR, `${id}.json`);
    await writeFile(file, JSON.stringify(film(id)));
    await writeFile(`${file}.proposal.tmp`, "{ \"repairProposal\":");
    const loaded = await readPersistedJob(id);
    expect(loaded?.repairProposal).toBeUndefined();
    expect(loaded?.shots).toHaveLength(1);
  });

  it("is visible to a second process after a review and a repair proposal are saved", async () => {
    const id = "seq_phase1_saved";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id, { spentUsd: 3.44 })));
    const review = reviewContinuity({
      shots: [
        { index: 1, worn: ["coat"], props: [{ id: "hanger", locationId: "room", placement: "wall" }] },
        { index: 2, worn: ["shirt"], props: [{ id: "hanger", locationId: "room", placement: "wall" }] },
      ],
      ledgerArtifact: `job:${id}#ledger`,
    });
    const graph = buildDependencyGraph([
      { index: 1, durationSeconds: 8, pin: "start", framePath: "/f/1.png" },
      { index: 2, durationSeconds: 8, pin: "both", firstFramePath: "/f/1.png", extendedFrom: "/f/ext.mp4" },
    ]);
    const proposal = proposeRepair({ graph, badShot: 1, resolution: "720p" });
    const saved = await saveJobAnnotation(id, (job) => {
      job.continuityReview = review;
      job.dependencies = graph;
      job.repairProposal = proposal;
      job.spendLedger = {
        version: 1,
        spentUsd: 3.44,
        pendingUsd: 1.12,
        thresholdUsd: 4,
      };
    });
    expect(saved.ok).toBe(true);
    const warning = assessBudget({ spentUsd: 3.44, pendingUsd: 1.12, thresholdUsd: 4 });
    expect(warning.authorizesSpend).toBe(false);
    expect(warning.crossed).toBe(true);

    const child = await showJob(id);
    expect(child.status, child.stderr).toBe(0);
    const body = JSON.parse(child.stdout) as {
      state: string;
      reviewVersion: number;
      findingCount: number;
      spendSpent: number;
      spendPending: number;
      spendThreshold: number;
      proposalVersion: number;
      proposalExecuted: boolean;
      dependencyEdges: number;
      filmPath: string;
      pin: string;
    };
    expect(body.state).toBe("completed");
    expect(body.pin).toBe("start");
    expect(body.reviewVersion).toBe(1);
    expect(body.findingCount).toBeGreaterThan(0);
    expect(body.spendSpent).toBe(3.44);
    expect(body.spendPending).toBe(1.12);
    expect(body.spendThreshold).toBe(4);
    expect(body.proposalVersion).toBe(1);
    expect(body.proposalExecuted).toBe(false);
    expect(body.dependencyEdges).toBeGreaterThan(0);
    expect(body.filmPath).toBe(`/keep/${id}.mp4`);
  });

  it("does not stop a running render to store a review", async () => {
    const id = "seq_phase1_running";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    await loadJobsFromDisk();
    const current = rememberedJob(id);
    if (!current) throw new Error("job was not loaded");
    current.state = "running";
    current.owner = thisOwner();
    await persistJob(current);

    const review = reviewContinuity({
      shots: [
        { index: 1, worn: ["coat"], props: [] },
        { index: 2, worn: ["coat"], props: [] },
      ],
    });
    const saved = await saveJobAnnotation(id, (job) => {
      job.continuityReview = review;
      job.state = "stopped";
    });
    expect(saved.ok).toBe(false);
    expect(rememberedJob(id)?.state).toBe("running");
    expect(rememberedJob(id)?.filmPath).toBe(`/keep/${id}.mp4`);
    expect(rememberedJob(id)?.continuityReview).toBeUndefined();

    const child = await showJob(id);
    expect(child.status, child.stderr).toBe(0);
    const body = JSON.parse(child.stdout) as { state: string; reviewVersion: number | null; filmPath: string };
    expect(body.state).toBe("running");
    expect(body.reviewVersion).toBeNull();
    expect(body.filmPath).toBe(`/keep/${id}.mp4`);

    current.state = "completed";
    current.owner = undefined;
    await persistJob(current);
  });
});

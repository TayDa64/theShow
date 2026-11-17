/**
 * Production recovers with no Bot and no Studio.
 * Children get a temp home. They are killed or awaited, then removed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveJobEvents, parseEventLog } from "../mcp/jobEvents.ts";
import { readProductionFeed } from "../mcp/productionFeed.ts";
import { waitForChildClose, waitForChildSignal } from "./child-signal.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHILD = path.join(ROOT, "tests/phase3-child.ts");
const children: ChildProcess[] = [];

function childEnv(jobs: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.dirname(jobs),
    THESHOW_JOBS_DIR: jobs,
    THESHOW_OUTPUT_DIR: path.join(path.dirname(jobs), "media"),
    THESHOW_CHARACTERS_DIR: path.join(path.dirname(jobs), "characters"),
    GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
    THESHOW_FORBID_HOME_AUTH: "1",
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function startChild(jobs: string, args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], {
    cwd: ROOT,
    env: { ...childEnv(jobs), ...extra },
  });
  children.push(child);
  return child;
}

async function jobsDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "theshow-p3-recover-"));
  const jobs = path.join(root, "jobs");
  await mkdir(jobs, { recursive: true });
  await mkdir(path.join(root, "media"), { recursive: true });
  await mkdir(path.join(root, "characters"), { recursive: true });
  return jobs;
}

function stoppedFilm(id: string): string {
  return JSON.stringify({
    id,
    startedAt: 1_700_000_000_000,
    state: "completed",
    finishedAt: 1_700_000_000_050,
    shotCount: 1,
    completed: 1,
    estimateUsd: 1,
    spentUsd: 1,
    shots: [{ index: 1, title: "A", status: "completed", prompt: "A lantern." }],
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForChildClose(child);
  }
});

describe("phase 3 recovery without a bot", () => {
  it.each(["stdio", "http"] as const)("kills the owner mid-append on %s and keeps the prefix", async (entry) => {
    const jobs = await jobsDir();
    const id = `seq_p3_hold_${entry}`;
    const child = startChild(jobs, ["hold", id, entry]);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    await waitForChildSignal(child, () => stderr, "event-append-hold", 10_000);
    child.kill("SIGKILL");
    await waitForChildClose(child);
    const jobFile = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { state: string };
    expect(jobFile.state).toBe("running");
    const torn = await readFile(path.join(jobs, ".events", `${id}.jsonl`));
    expect(torn.toString("utf8")).toBe("{\"partial\"");

    const reaper = startChild(jobs, ["reap", id, entry]);
    const reaped = await new Promise<string>((resolve, reject) => {
      let out = "";
      reaper.stdout?.setEncoding("utf8");
      reaper.stdout?.on("data", (chunk: string) => { out += chunk; });
      reaper.on("error", reject);
      reaper.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`reap ${code}`)));
    });
    expect(reaped).toContain("reaped");
    expect(await readFile(path.join(jobs, ".events", `${id}.jsonl`))).toEqual(torn);
    const stopped = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { state: string };
    expect(stopped.state).toBe("stopped");

    const reviewer = startChild(jobs, ["review", id, entry]);
    await new Promise<void>((resolve, reject) => {
      reviewer.on("error", reject);
      reviewer.on("close", (code) => code === 0 ? resolve() : reject(new Error(`review ${code}`)));
    });
    const next = await readFile(path.join(jobs, ".events", `${id}.jsonl`));
    expect(next.subarray(0, torn.byteLength)).toEqual(torn);
    expect(next.toString("utf8").startsWith("{\"partial\"\n")).toBe(true);
    const parsed = parseEventLog(next.toString("utf8"), id);
    expect(parsed.tornLines).toBe(1);
    expect(parsed.events.some((event) => event.type === "review.recorded")).toBe(true);
  }, 20_000);

  it.each(["stdio", "http"] as const)("reconciles a kill between rename and append on %s", async (entry) => {
    const jobs = await jobsDir();
    const id = `seq_p3_gap_${entry}`;
    const child = startChild(jobs, ["gap", id, entry]);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    await waitForChildSignal(child, () => stderr, "event-append-hold", 10_000);
    child.kill("SIGKILL");
    await waitForChildClose(child);
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    const reaper = startChild(jobs, ["reap", id, entry]);
    await new Promise<void>((resolve, reject) => {
      reaper.on("error", reject);
      reaper.on("close", (code) => code === 0 ? resolve() : reject(new Error(`reap ${code}`)));
    });
    const reviewer = startChild(jobs, ["review", id, entry]);
    await new Promise<void>((resolve, reject) => {
      reviewer.on("error", reject);
      reviewer.on("close", (code) => code === 0 ? resolve() : reject(new Error(`review ${code}`)));
    });
    const parsed = parseEventLog(await readFile(path.join(jobs, ".events", `${id}.jsonl`), "utf8"), id);
    const ids = parsed.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(deriveJobEvents({
      id,
      state: "stopped",
      shotCount: 1,
      shots: [],
    }).find((event) => event.type === "job.stopped")?.id);
  }, 20_000);

  it("shows owner-gone without writing, then a reconciled stop after the reap", async () => {
    const jobs = await jobsDir();
    const id = "seq_p3_gone";
    await writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
      id,
      startedAt: 4,
      state: "running",
      shotCount: 1,
      completed: 0,
      estimateUsd: 1,
      spentUsd: 0,
      shots: [],
      owner: { pid: 999_999, token: "gone", host: "other-host", heartbeatAt: 1 },
    }));
    const before = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 20 });
    if ("refused" in before) throw new Error(before.reason);
    expect(before.jobs[0]?.liveness).toBe("owner-gone-awaiting-reap");
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    const reaper = startChild(jobs, ["reap", id, "stdio"]);
    await new Promise<void>((resolve, reject) => {
      reaper.on("error", reject);
      reaper.on("close", (code) => code === 0 ? resolve() : reject(new Error(`reap ${code}`)));
    });
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    const after = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 20 });
    if ("refused" in after) throw new Error(after.reason);
    const stopped = after.events.find((event) => event.type === "job.stopped");
    expect(stopped?.source).toBe("reconciled");
    expect(stopped?.id).toBe(deriveJobEvents({ id, state: "stopped", shotCount: 1, shots: [] }).find((event) => event.type === "job.stopped")?.id);
  });

  it.each(["stdio", "http"] as const)("lets two processes take turns without duplicate ids on %s", async (entry) => {
    const jobs = await jobsDir();
    const id = `seq_p3_turns_${entry}`;
    await writeFile(path.join(jobs, `${id}.json`), stoppedFilm(id));
    for (const mode of ["review", "repair"] as const) {
      const child = startChild(jobs, [mode, id, entry]);
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => resolve(status));
      });
      expect(code, stderr).toBe(0);
    }
    const parsed = parseEventLog(await readFile(path.join(jobs, ".events", `${id}.jsonl`), "utf8"), id);
    const ids = parsed.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.seqCollisions).toBe(0);
    expect(parsed.events.map((event) => event.seq)).toEqual([...parsed.events.keys()].map((index) => index + 1));
    expect(parsed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["review.recorded", "repair.proposed", "budget.set"]));
  }, 20_000);

  it("keeps a cursor across a second read of the same home", async () => {
    const jobs = await jobsDir();
    const id = "seq_p3_restart";
    await writeFile(path.join(jobs, `${id}.json`), stoppedFilm(id));
    const reviewer = startChild(jobs, ["review", id, "stdio"]);
    await new Promise<void>((resolve, reject) => {
      reviewer.on("error", reject);
      reviewer.on("close", (code) => code === 0 ? resolve() : reject(new Error(`review ${code}`)));
    });
    const first = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 2 });
    if ("refused" in first) throw new Error(first.reason);
    const child = startChild(jobs, ["feed", id, "http"]);
    const raw = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { out += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`feed ${code}`)));
    });
    const second = JSON.parse(raw) as { events: Array<{ id: string }>; cursor: string };
    const replay = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 2, cursor: first.cursor });
    const replayAgain = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 2, cursor: first.cursor });
    if ("refused" in replay || "refused" in replayAgain) throw new Error("cursor refused");
    expect(replayAgain.events.map((event) => event.id)).toEqual(replay.events.map((event) => event.id));
    const seen = new Set(first.events.map((event) => event.id));
    expect(replay.events.every((event) => !seen.has(event.id))).toBe(true);
    expect(second.events.map((event) => event.id)).toEqual(
      (await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 50 }) as { events: Array<{ id: string }> }).events.map((event) => event.id),
    );
  });

  it("still reviews when the event directory cannot be created", async () => {
    const jobs = await jobsDir();
    const id = "seq_p3_unwritable";
    await writeFile(path.join(jobs, `${id}.json`), stoppedFilm(id));
    await writeFile(path.join(jobs, ".events"), "not-a-directory");
    const child = startChild(jobs, ["review", id, "stdio"]);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve(status));
    });
    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`theShow: event log append failed for ${id}:`);
    expect(stderr.match(/event log append failed/g)).toHaveLength(1);
    const disk = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { continuityReview?: { version: number } };
    expect(disk.continuityReview?.version).toBe(1);
    const repair = startChild(jobs, ["repair", id, "stdio"]);
    let repairErr = "";
    repair.stderr?.setEncoding("utf8");
    repair.stderr?.on("data", (chunk: string) => { repairErr += chunk; });
    const repairCode = await new Promise<number | null>((resolve, reject) => {
      repair.on("error", reject);
      repair.on("close", (status) => resolve(status));
    });
    expect(repairCode, repairErr).toBe(0);
    expect(repairErr.match(/event log append failed/g)).toHaveLength(1);
    const render = startChild(jobs, ["render", id, "stdio"], {
      VITEST: "true",
      NODE_ENV: "test",
      THESHOW_STUB_VIDEO: "completed",
    });
    let renderErr = "";
    let renderOut = "";
    render.stderr?.setEncoding("utf8");
    render.stdout?.setEncoding("utf8");
    render.stderr?.on("data", (chunk: string) => { renderErr += chunk; });
    render.stdout?.on("data", (chunk: string) => { renderOut += chunk; });
    const renderCode = await new Promise<number | null>((resolve, reject) => {
      render.on("error", reject);
      render.on("close", (status) => resolve(status));
    });
    expect(renderCode, `${renderErr}\n${renderOut}`).toBe(0);
    expect(renderOut).toContain("jobId");
    expect(renderOut).not.toContain("event log append failed");
    expect(renderErr.match(/event log append failed/g)?.length ?? 0).toBeLessThanOrEqual(1);
    const feed = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 20 });
    if ("refused" in feed) throw new Error(feed.reason);
    expect(feed.events.some((event) => event.type === "review.recorded" && event.source === "reconciled")).toBe(true);
  });
});

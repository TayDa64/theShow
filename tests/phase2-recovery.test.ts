/**
 * A killed advisory call leaves the films as they were. No bot is running.
 * The pause waits for the child's own signal, then a ceiling, the same way
 * the Phase 1 recovery handshake does.
 *
 * N36: at R2 this file passed 9/10, and the miss was the 60s signal ceiling
 * while the machine's load average was about 9. The wait is still the child's
 * own line (`child-ready`, then `paused-*`). The ceiling is only the backstop,
 * raised to 180s so a loaded tsx start can still print that line. Assertions
 * are unchanged.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sweepOrphanTemps, sweepStaleReviewFrames } from "../mcp/runtime.ts";
import { waitForChildClose, waitForChildSignal } from "./child-signal.ts";

const SIGNAL_CEILING_MS = 180_000;
const RECOVERY_TEST_MS = 300_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "tests/mcp-multi-child.ts");

function childEnv(jobs: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.dirname(jobs);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_JOBS_DIR: jobs,
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    THESHOW_CONSISTENCY_DIR: path.join(home, "consistency"),
    GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
    THESHOW_FORBID_HOME_AUTH: "1",
    ...extra,
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

async function homeDir(): Promise<{ home: string; jobs: string; consistency: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "theshow-phase2-"));
  const jobs = path.join(home, "jobs");
  await mkdir(jobs, { recursive: true });
  await mkdir(path.join(home, "consistency"), { recursive: true });
  return { home, jobs, consistency: path.join(home, "consistency") };
}

function film(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startedAt: 10,
    state: "completed",
    shotCount: 1,
    completed: 1,
    estimateUsd: 1,
    spentUsd: 1,
    shots: [{ index: 1, title: "Old", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      fadeDuration: 0,
      assemble: false,
      pin: "start",
    },
    ...extra,
  };
}

async function sha(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function spawnAdvisory(
  jobs: string,
  tool: string,
  payload: string,
  extra: Record<string, string> = {},
): { child: ReturnType<typeof spawn>; text: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, "advisory", tool, payload], {
    cwd: ROOT,
    env: childEnv(jobs, extra),
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  return { child, text: () => stdout };
}

describe("phase 2 recovery", () => {
  it("kills suggest_coverage before it reads and leaves the film untouched", async () => {
    const { jobs } = await homeDir();
    const id = "seq_phase2_kill_suggest";
    const file = path.join(jobs, `${id}.json`);
    const body = JSON.stringify(film(id));
    await writeFile(file, body);
    const payload = path.join(jobs, "suggest.json");
    await writeFile(payload, JSON.stringify({ jobId: id }));
    const { child, text } = spawnAdvisory(jobs, "suggest_coverage", payload, { THESHOW_PAUSE_ADVISORY: "1" });
    await waitForChildSignal(child, text, "child-ready", SIGNAL_CEILING_MS);
    await waitForChildSignal(child, text, "paused-advisory", SIGNAL_CEILING_MS);
    child.kill("SIGKILL");
    await waitForChildClose(child);
    expect(await readFile(file, "utf8")).toBe(body);
    expect((await readdir(jobs)).filter((name) => name.startsWith(".review-frames-"))).toEqual([]);
  }, RECOVERY_TEST_MS);

  it("kills check_cross_film after the frame directory is created and the sweep removes it", async () => {
    const { jobs } = await homeDir();
    const clip = path.join(jobs, "clip.bin");
    await writeFile(clip, "not-a-video");
    const ids = ["seq_phase2_frame_a", "seq_phase2_frame_b"];
    const originals = new Map<string, string>();
    for (const id of ids) {
      const body = JSON.stringify(film(id, {
        shots: [{ index: 1, title: "Old", status: "completed", localPath: clip, durationSeconds: 8, prompt: "A lantern." }],
      }));
      const file = path.join(jobs, `${id}.json`);
      await writeFile(file, body);
      originals.set(file, body);
    }
    const payload = path.join(jobs, "frames.json");
    await writeFile(payload, JSON.stringify({ jobIds: ids }));
    const { child, text } = spawnAdvisory(jobs, "check_cross_film", payload, { THESHOW_PAUSE_FRAMES: "1" });
    await waitForChildSignal(child, text, "child-ready", SIGNAL_CEILING_MS);
    await waitForChildSignal(child, text, "paused-frames", SIGNAL_CEILING_MS);
    child.kill("SIGKILL");
    await waitForChildClose(child);
    const stray = (await readdir(jobs)).filter((name) => name.startsWith(".review-frames-"));
    expect(stray.length).toBeGreaterThan(0);
    await sweepStaleReviewFrames(jobs);
    expect((await readdir(jobs)).filter((name) => name.startsWith(".review-frames-"))).toEqual([]);
    for (const [file, body] of originals) expect(await readFile(file, "utf8")).toBe(body);
  }, RECOVERY_TEST_MS);

  it("kills an opt-in report before rename and sweeps the temp file", async () => {
    const { jobs, consistency } = await homeDir();
    const ids = ["seq_phase2_persist_a", "seq_phase2_persist_b"];
    const before = new Map<string, string>();
    for (const id of ids) {
      const file = path.join(jobs, `${id}.json`);
      await writeFile(file, JSON.stringify(film(id)));
      before.set(file, await sha(file));
    }
    const payload = path.join(jobs, "persist.json");
    await writeFile(payload, JSON.stringify({ jobIds: ids, persist: true }));
    const { child, text } = spawnAdvisory(jobs, "check_cross_film", payload, { THESHOW_PAUSE_BEFORE_RENAME: "1" });
    await waitForChildSignal(child, text, "child-ready", SIGNAL_CEILING_MS);
    await waitForChildSignal(child, text, "paused-before-rename", SIGNAL_CEILING_MS);
    child.kill("SIGKILL");
    await waitForChildClose(child);
    const reports = (await readdir(consistency)).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
    expect(reports).toEqual([]);
    const temps = (await readdir(consistency)).filter((name) => name.endsWith(".tmp"));
    expect(temps.length).toBeGreaterThan(0);
    await sweepOrphanTemps(consistency);
    expect(await readdir(consistency)).toEqual([]);
    for (const [file, digest] of before) expect(await sha(file)).toBe(digest);
    expect(await stat(path.join(jobs, `${ids[0]}.json`))).toBeTruthy();
  }, RECOVERY_TEST_MS);

  it("shows the same advisory result to two processes and does not start a bot", async () => {
    const { jobs } = await homeDir();
    const ids = ["seq_phase2_same_a", "seq_phase2_same_b"];
    for (const id of ids) await writeFile(path.join(jobs, `${id}.json`), JSON.stringify(film(id)));
    const payload = path.join(jobs, "same.json");
    await writeFile(payload, JSON.stringify({ jobIds: ids }));
    const first = spawnAdvisory(jobs, "check_cross_film", payload);
    const second = spawnAdvisory(jobs, "check_cross_film", payload);
    const [left, right] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        first.child.on("error", reject);
        first.child.on("close", (status) => {
          if (status !== 0) reject(new Error(first.text()));
          else resolve(first.text());
        });
      }),
      new Promise<string>((resolve, reject) => {
        second.child.on("error", reject);
        second.child.on("close", (status) => {
          if (status !== 0) reject(new Error(second.text()));
          else resolve(second.text());
        });
      }),
    ]);
    expect(JSON.parse(left)).toEqual(JSON.parse(right));
    expect(left).not.toContain("costQuote");
  }, RECOVERY_TEST_MS);
});

/**
 * Review fixes for elicitation, character locks, render claims, and job writes.
 * No generator is called and no credential file is read.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { holdCharacterLock, saveCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { flushJobWrites, jobShouldStop } from "../mcp/runtime.ts";
import {
  claimFilm,
  createTheShowServer,
  persistJob,
  refreshJobsFromDisk,
  releaseFilmClaim,
  server,
  type SequenceJob,
} from "../mcp/server.ts";

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

describe("stdio elicitation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a form answer that arrives after the HTTP timeout", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "stdio-elicit", version: "0.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return { action: "accept" as const, content: { scene: "a quiet room" } };
    });
    await client.connect(clientTransport);

    vi.useFakeTimers();
    const pending = client.callTool({ name: "configure_film", arguments: {} });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    const body = JSON.parse(toolText(result)) as { action?: string; config?: { scene?: string } };
    expect(body.action, toolText(result)).toBe("accept");
    expect(body.config?.scene).toBe("a quiet room");
    await client.close();
    await server.close();
  });
});

describe("character lock", () => {
  it("recovers a lock left by a dead pid", async () => {
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-lock-"));
    process.env.THESHOW_CHARACTERS_DIR = dir;
    try {
      const folder = path.join(dir, "ada");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, ".write.lock"), JSON.stringify({
        pid: 2_000_000_000,
        token: "dead",
        host: hostname(),
        at: Date.now(),
      }));
      const saved = await saveCharacter({ name: "Ada", role: "lead" });
      expect(saved.role).toBe("lead");
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  });

  it("waits out a live lock and then saves", async () => {
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-lock-"));
    process.env.THESHOW_CHARACTERS_DIR = dir;
    try {
      const folder = path.join(dir, "bea");
      await mkdir(folder, { recursive: true });
      const lock = path.join(folder, ".write.lock");
      await writeFile(lock, JSON.stringify({
        pid: process.pid,
        token: "holder",
        host: hostname(),
        at: Date.now(),
      }));
      const pending = saveCharacter({ name: "Bea", description: "short" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await unlink(lock);
      const saved = await pending;
      expect(saved.description).toBe("short");
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  });

  it("keeps the lock while a save runs longer than the stale window", async () => {
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    const previousRefresh = process.env.THESHOW_CHARACTER_LOCK_REFRESH_MS;
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-lock-"));
    process.env.THESHOW_CHARACTERS_DIR = dir;
    process.env.THESHOW_CHARACTER_LOCK_REFRESH_MS = "20";
    const now = vi.spyOn(Date, "now");
    let releaseHold: () => void = () => undefined;
    try {
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let acquired: () => void = () => undefined;
      const acquiredPromise = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const started = Date.now();
      now.mockReturnValue(started);
      const holder = holdCharacterLock("Ada", async () => {
        await writeFile(path.join(dir, "ada", "character.json"), JSON.stringify({
          id: "char_ada",
          name: "Ada",
          referenceImageUrls: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }));
        acquired();
        await hold;
        await writeFile(path.join(dir, "ada", "character.json"), JSON.stringify({
          id: "char_ada",
          name: "Ada",
          description: "tall",
          referenceImageUrls: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }));
      });
      await acquiredPromise;
      now.mockReturnValue(started + 35_000);
      const lockPath = path.join(dir, "ada", ".write.lock");
      await vi.waitFor(() => {
        const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { at: number };
        expect(parsed.at).toBeGreaterThanOrEqual(started + 35_000);
      }, { timeout: 1_000, interval: 10 });

      let saverDone = false;
      const saver = saveCharacter({ name: "Ada", role: "lead" }).then((record) => {
        saverDone = true;
        return record;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(saverDone).toBe(false);
      releaseHold();
      const saved = await saver;
      await holder;
      expect(saved.role).toBe("lead");
      expect(saved.description).toBe("tall");
    } finally {
      releaseHold();
      now.mockRestore();
      vi.useRealTimers();
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
      if (previousRefresh === undefined) delete process.env.THESHOW_CHARACTER_LOCK_REFRESH_MS;
      else process.env.THESHOW_CHARACTER_LOCK_REFRESH_MS = previousRefresh;
    }
  });
});

function film(id: string, extra: Partial<SequenceJob> = {}): SequenceJob {
  return {
    id,
    startedAt: 1,
    state: "completed",
    shotCount: 1,
    completed: 1,
    estimateUsd: 0,
    spentUsd: 0,
    shots: [{ index: 1, title: "Shot", status: "completed", localPath: "/tmp/clip.mp4" }],
    ...extra,
  };
}

describe("film claim", () => {
  beforeEach(async () => {
    await mkdir(JOBS_DIR, { recursive: true });
  });

  it("blocks a second claim while the first owner is alive", async () => {
    const id = "seq_claim_block";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    const first = await claimFilm(id);
    expect(first.ok).toBe(true);
    const second = await claimFilm(id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toBe("already running in this process");
    await releaseFilmClaim(id);
    const third = await claimFilm(id);
    expect(third.ok).toBe(true);
    await releaseFilmClaim(id);
  });

  it("lets exactly one resume take a dead claim, over many races", async () => {
    for (let round = 0; round < 20; round++) {
      const id = `seq_race_${round}_${Date.now().toString(36)}`;
      await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
      await writeFile(path.join(JOBS_DIR, `${id}.claim`), JSON.stringify({
        pid: 2_000_000_000,
        token: "dead",
        host: hostname(),
        heartbeatAt: Date.now(),
      }));
      const results = await Promise.all(Array.from({ length: 8 }, () => claimFilm(id)));
      const wins = results.filter((result) => result.ok);
      expect(wins, JSON.stringify(results)).toHaveLength(1);
      await releaseFilmClaim(id);
    }
  });

  it("recovers an empty claim after a short grace period", async () => {
    const id = "seq_empty_claim";
    const claim = path.join(JOBS_DIR, `${id}.claim`);
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    await writeFile(claim, "");
    // Stamp the file from the same clock claimFilm reads. A bare write can look
    // old when Date.now is ahead of the filesystem clock.
    const freshStamp = new Date(Date.now() + 5_000);
    await utimes(claim, freshStamp, freshStamp);
    const fresh = await claimFilm(id);
    expect(fresh.ok).toBe(false);
    const past = new Date(Date.now() - 3_000);
    await utimes(claim, past, past);
    const recovered = await claimFilm(id);
    expect(recovered.ok).toBe(true);
    const body = await readFile(claim, "utf8");
    expect(body.length).toBeGreaterThan(0);
    expect(JSON.parse(body).pid).toBe(process.pid);
    await releaseFilmClaim(id);
  });

  it("releases the claim when resume throws after it was taken", async () => {
    const id = `seq_throw_${Date.now().toString(36)}`;
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    process.env.XAI_API_KEY = "test-key-not-a-real-credential";
    process.env.THESHOW_THROW_AFTER_CLAIM = "1";
    const show = createTheShowServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await show.connect(serverTransport);
    const client = new Client({ name: "claim-throw", version: "0.0.0" });
    await client.connect(clientTransport);
    const arguments_ = {
      confirm: true,
      overrideValidation: true,
      resumeFromJobId: id,
      shots: [{ prompt: "He sits.", durationSeconds: 4 }],
    };
    try {
      let thrown = "";
      try {
        const result = await client.callTool({ name: "render_sequence", arguments: arguments_ });
        thrown = toolText(result);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      expect(thrown).toContain("throw after claim");
      expect(thrown).not.toContain("already running");
      expect(existsSync(path.join(JOBS_DIR, `${id}.claim`))).toBe(false);

      let secondText = "";
      try {
        const second = await client.callTool({ name: "render_sequence", arguments: arguments_ });
        secondText = toolText(second);
      } catch (err) {
        secondText = err instanceof Error ? err.message : String(err);
      }
      expect(secondText).toContain("throw after claim");
      expect(secondText).not.toContain("already running");
      expect(existsSync(path.join(JOBS_DIR, `${id}.claim`))).toBe(false);
    } finally {
      delete process.env.THESHOW_THROW_AFTER_CLAIM;
      delete process.env.XAI_API_KEY;
      await client.close();
      await show.close();
    }
  });
});

describe("job write order", () => {
  beforeEach(async () => {
    await mkdir(JOBS_DIR, { recursive: true });
  });

  it("does not let a heartbeat snapshot overwrite a completed film", async () => {
    const id = "seq_write_order";
    const job = film(id, {
      state: "running",
      completed: 0,
      shots: [],
      owner: { pid: process.pid, token: "local", host: hostname(), heartbeatAt: Date.now() },
    });
    const heartbeat = persistJob(job);
    job.state = "completed";
    job.filmPath = "/films/done.mp4";
    const finished = persistJob(job);
    await Promise.all([heartbeat, finished]);
    await flushJobWrites();
    const disk = JSON.parse(readFileSync(path.join(JOBS_DIR, `${id}.json`), "utf8")) as SequenceJob;
    expect(disk.state).toBe("completed");
    expect(disk.filmPath).toBe("/films/done.mp4");
  });

  it("keeps a recorded film path when a stale running copy is reaped", async () => {
    const id = `seq_reap_${Date.now().toString(36)}`;
    const owner = {
      pid: 2_000_000_000,
      token: "dead",
      host: hostname(),
      heartbeatAt: Date.now() - 120_000,
    };
    expect(jobShouldStop(owner)).toBe(true);
    const running = film(id, {
      state: "running",
      completed: 0,
      filmPath: "/films/partial.mp4",
      owner,
    });
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(running));
    await refreshJobsFromDisk();
    await flushJobWrites();
    const disk = JSON.parse(readFileSync(path.join(JOBS_DIR, `${id}.json`), "utf8")) as SequenceJob;
    expect(disk.state, JSON.stringify(disk)).toBe("stopped");
    expect(disk.filmPath).toBe("/films/partial.mp4");
  });
});

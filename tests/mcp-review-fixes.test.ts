/**
 * Review fixes for elicitation, character locks, render claims, and job writes.
 * No generator is called and no credential file is read.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { saveCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { flushJobWrites, jobShouldStop } from "../mcp/runtime.ts";
import {
  claimFilm,
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
  it("blocks a second claim while the first owner is alive", async () => {
    const id = "seq_claim_block";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(film(id)));
    const first = await claimFilm(id);
    expect(first.ok).toBe(true);
    const second = await claimFilm(id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toBe("already running in another process");
    await releaseFilmClaim(id);
    const third = await claimFilm(id);
    expect(third.ok).toBe(true);
    await releaseFilmClaim(id);
  });
});

describe("job write order", () => {
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

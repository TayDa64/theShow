/**
 * The feed is a pure read. production_feed does not reap, and a cursor resumes
 * without duplicating ids.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JOBS_DIR } from "../mcp/media.ts";
import { readProductionFeed } from "../mcp/productionFeed.ts";
import { deriveJobEvents, setBeforeEventAppendProbe } from "../mcp/jobEvents.ts";
import { server } from "../mcp/server.ts";
import { flushJobWrites } from "../mcp/runtime.ts";

let client: Client;

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return (content[0] as { text?: string } | undefined)?.text ?? "";
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "phase3-feed", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("production feed", () => {
  it("lists production_feed last and returns structured content that matches the text", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names.at(-1)).toBe("production_feed");
    expect(names).toHaveLength(18);
    const tool = listed.tools.at(-1);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tool?.description).toMatch(/read-only/i);
    expect(tool?.description).toMatch(/never required for production/i);
    const result = await client.callTool({ name: "production_feed", arguments: { limit: 5 } });
    const text = toolText(result);
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    expect(structured).toEqual(JSON.parse(text));
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it("keeps check_sequence and list_films text byte-identical to structuredContent", async () => {
    const id = `seq_p3_struct_${Date.now().toString(36)}`;
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify({
      id,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_050,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      filmPath: path.join(JOBS_DIR, "reel.mp4"),
      shots: [{ index: 1, title: "Lantern", status: "completed", prompt: "A lantern.", costUsd: 1, durationSeconds: 4 }],
    }));
    const assertMatch = (result: unknown) => {
      const text = toolText(result);
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      expect(structured).toEqual(JSON.parse(text));
      expect(JSON.stringify(structured, null, 2)).toBe(text);
      return text;
    };
    await client.callTool({ name: "list_films", arguments: { includeUnfinished: true, limit: 50 } });
    const listed = assertMatch(await client.callTool({ name: "list_films", arguments: { includeUnfinished: true, limit: 50 } }));
    expect(assertMatch(await client.callTool({ name: "list_films", arguments: { includeUnfinished: true, limit: 50 } }))).toBe(listed);
    const checked = assertMatch(await client.callTool({ name: "check_sequence", arguments: { jobId: id } }));
    expect(assertMatch(await client.callTool({ name: "check_sequence", arguments: { jobId: id } }))).toBe(checked);
    const missing = assertMatch(await client.callTool({ name: "check_sequence", arguments: { jobId: "seq_p3_struct_missing" } }));
    expect(JSON.parse(missing).error).toBe("Unknown jobId");
    expect(assertMatch(await client.callTool({ name: "check_sequence", arguments: { jobId: "seq_p3_struct_missing" } }))).toBe(missing);
  });

  it("refuses a job id that could leave the jobs directory", async () => {
    for (const jobId of ["../x", "/etc/passwd", "a/b"]) {
      const result = await client.callTool({ name: "production_feed", arguments: { jobId } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const body = JSON.parse(toolText(result)) as { abstentions?: Array<{ reason?: string }> };
      expect(body.abstentions?.[0]?.reason).toMatch(/not confined/);
      expect((result as { structuredContent?: typeof body }).structuredContent).toEqual(body);
    }
  });

  it("does not reap a dead owner and does not change the directory", async () => {
    const id = `seq_p3_pure_${Date.now().toString(36)}`;
    const file = path.join(JOBS_DIR, `${id}.json`);
    const body = {
      id,
      startedAt: 5,
      state: "running",
      shotCount: 1,
      completed: 0,
      estimateUsd: 1,
      spentUsd: 0,
      shots: [],
      owner: { pid: 999_999, token: "gone", host: "other-host", heartbeatAt: 1 },
    };
    await writeFile(file, JSON.stringify(body));
    const torn = path.join(JOBS_DIR, ".events", `${id}.jsonl`);
    await mkdir(path.dirname(torn), { recursive: true });
    await writeFile(torn, "{\"torn\":");
    const noteDir = path.join(JOBS_DIR, ".spend-journal", id);
    await mkdir(noteDir, { recursive: true });
    await writeFile(path.join(noteDir, "torn-note"), "{");
    const tmp = path.join(JOBS_DIR, `${id}.tmp`);
    await writeFile(tmp, "temp");
    const stamp = async (target: string) => {
      const info = await stat(target);
      return `${info.mtimeMs}:${createHash("sha256").update(await readFile(target)).digest("hex")}`;
    };
    const targets = [file, torn, path.join(noteDir, "torn-note"), tmp];
    const before = await Promise.all(targets.map(stamp));
    const listing = (await readdir(JOBS_DIR)).sort();
    for (let i = 0; i < 50; i += 1) {
      await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 20 });
      await client.callTool({ name: "production_feed", arguments: { jobId: id, limit: 20 } });
    }
    expect(JSON.parse(await readFile(file, "utf8")).state).toBe("running");
    expect(await Promise.all(targets.map(stamp))).toEqual(before);
    expect((await readdir(JOBS_DIR)).sort()).toEqual(listing);
    const feed = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 20 });
    if ("refused" in feed) throw new Error(feed.reason);
    expect(feed.jobs[0]?.liveness).toBe("owner-gone-awaiting-reap");
    expect(feed.jobs[0]?.log.tornLines).toBe(1);
    expect(feed.abstentions.some((entry) => entry.reason === "torn journal note")).toBe(true);
  });

  it("resumes a cursor without duplicate ids and treats a garbage cursor as a fresh read", async () => {
    const id = `seq_p3_cursor_${Date.now().toString(36)}`;
    const body = {
      id,
      startedAt: 8,
      state: "completed" as const,
      finishedAt: 9,
      shotCount: 4,
      completed: 4,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [1, 2, 3, 4].map((index) => ({ index, title: `S${index}`, status: index === 4 ? "failed" : "completed" })),
    };
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(body));
    const fresh = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 50 });
    if ("refused" in fresh) throw new Error(fresh.reason);
    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    while (guard < 20) {
      const page = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 2, cursor });
      if ("refused" in page) throw new Error(page.reason);
      collected.push(...page.events.map((event) => event.id));
      const again = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 2, cursor });
      if ("refused" in again) throw new Error(again.reason);
      expect(again.events.map((event) => event.id)).toEqual(page.events.map((event) => event.id));
      if (!page.truncated) break;
      cursor = page.cursor;
      guard += 1;
    }
    expect(collected).toEqual(fresh.events.map((event) => event.id));
    expect(new Set(collected).size).toBe(collected.length);
    const garbage = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 50, cursor: "%%%not-a-cursor%%%" });
    if ("refused" in garbage) throw new Error(garbage.reason);
    expect(garbage.events.map((event) => event.id)).toEqual(fresh.events.map((event) => event.id));
    const digestIds = ["ev_" + "cd".repeat(16)];
    const digest = `${createHash("sha256").update(digestIds.join("\0")).digest("hex")}.${Buffer.from(JSON.stringify(digestIds), "utf8").toString("base64url")}`;
    const malformed = [
      Buffer.from(JSON.stringify({ v: 2, jobs: {} }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, jobs: { "../x": { seq: 0, reconciledDigest: digest } } }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, jobs: { [id]: { seq: 0, reconciledDigest: "not-a-digest" } } }), "utf8").toString("base64url"),
    ];
    for (const cursor of malformed) {
      const page = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id, limit: 50, cursor });
      if ("refused" in page) throw new Error(page.reason);
      expect(page.events.map((event) => event.id)).toEqual(fresh.events.map((event) => event.id));
    }
    expect(fresh.events.map((event) => event.id).sort()).toEqual(deriveJobEvents(body).map((event) => event.id).sort());
  });

  it("returns review and repair while a hung append is still pending, and releases the claim", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    setBeforeEventAppendProbe(() => pending);
    try {
      const reviewId = `seq_p3_fast_${Date.now().toString(36)}`;
      await writeFile(path.join(JOBS_DIR, `${reviewId}.json`), JSON.stringify({
        id: reviewId,
        startedAt: 1,
        state: "completed",
        finishedAt: 2,
        shotCount: 1,
        completed: 1,
        estimateUsd: 1,
        spentUsd: 0,
        shots: [{ index: 1, title: "A", status: "completed", prompt: "A lantern." }],
      }));
      const reviewStarted = Date.now();
      const review = await client.callTool({ name: "review_continuity", arguments: { jobId: reviewId } });
      expect(Date.now() - reviewStarted).toBeLessThan(1_000);
      expect(JSON.parse(toolText(review)).persisted).toBe(true);
      const disk = JSON.parse(await readFile(path.join(JOBS_DIR, `${reviewId}.json`), "utf8")) as { claim?: unknown };
      expect(disk.claim).toBeUndefined();
      await expect(readFile(path.join(JOBS_DIR, `${reviewId}.claim`))).rejects.toThrow();
      await expect(readFile(path.join(JOBS_DIR, ".events", `${reviewId}.jsonl`))).rejects.toThrow();

      const repairId = `seq_p3_fast_repair_${Date.now().toString(36)}`;
      await writeFile(path.join(JOBS_DIR, `${repairId}.json`), JSON.stringify({
        id: repairId,
        startedAt: 1,
        state: "completed",
        finishedAt: 2,
        shotCount: 1,
        completed: 1,
        estimateUsd: 1,
        spentUsd: 0,
        shots: [{ index: 1, title: "A", status: "failed", prompt: "A lantern." }],
      }));
      const repairStarted = Date.now();
      const repair = await client.callTool({
        name: "propose_repair",
        arguments: { jobId: repairId, badShot: 1, budgetUsd: 3 },
      });
      expect(Date.now() - repairStarted).toBeLessThan(1_000);
      expect(JSON.parse(toolText(repair)).persisted).toBe(true);
      await expect(readFile(path.join(JOBS_DIR, ".events", `${repairId}.jsonl`))).rejects.toThrow();
    } finally {
      release();
      setBeforeEventAppendProbe(undefined);
      await flushJobWrites();
    }
  });

  it("returns render_sequence before the terminal event append finishes", async () => {
    process.env.THESHOW_STUB_VIDEO = "completed";
    let entered = 0;
    setBeforeEventAppendProbe(async () => {
      if (entered === 0) entered = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    try {
      const started = Date.now();
      const result = await client.callTool({
        name: "render_sequence",
        arguments: {
          shots: [{ prompt: "A lantern sits on a wooden table.", durationSeconds: 4, title: "Lantern" }],
          confirm: true,
          overrideValidation: true,
          assemble: false,
        },
      });
      const returned = Date.now();
      expect(returned - started).toBeLessThan(1_000);
      const payload = JSON.parse(toolText(result)) as { jobId?: string };
      expect(payload.jobId).toMatch(/^seq_/);
      const logPath = path.join(JOBS_DIR, ".events", `${payload.jobId}.jsonl`);
      const deadline = Date.now() + 8_000;
      let text = "";
      let sawStopped = 0;
      while (Date.now() < deadline) {
        try {
          text = await readFile(logPath, "utf8");
          if (text.includes("job.stopped")) {
            sawStopped = Date.now();
            break;
          }
        } catch { /* the append is still inside the probe */ }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(text).toContain("job.stopped");
      expect(sawStopped).toBeGreaterThan(returned);
      expect(sawStopped - entered).toBeGreaterThanOrEqual(700);
      expect(returned).toBeLessThan(entered + 700);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
      setBeforeEventAppendProbe(undefined);
      await flushJobWrites();
    }
  }, 15_000);
});

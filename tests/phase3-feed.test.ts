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
import { deriveJobEvents } from "../mcp/jobEvents.ts";
import { server } from "../mcp/server.ts";

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
    expect(fresh.events.map((event) => event.id).sort()).toEqual(deriveJobEvents(body).map((event) => event.id).sort());
  });
});

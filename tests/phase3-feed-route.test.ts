/**
 * Studio production feed route. Loopback only. It does not write the jobs directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { readProductionFeed, studioFeedRequestAllowed } from "../mcp/productionFeed.ts";
import { app } from "../server.ts";

const originalJobs = process.env.THESHOW_JOBS_DIR;
const originalFeed = process.env.THESHOW_STUDIO_FEED;

async function home(): Promise<string> {
  const root = path.join(tmpdir(), `theshow-feed-route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const jobs = path.join(root, "jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(path.join(jobs, "seq_route_film.json"), JSON.stringify({
    id: "seq_route_film",
    startedAt: 10,
    state: "completed",
    finishedAt: 20,
    shotCount: 1,
    completed: 1,
    estimateUsd: 1,
    spentUsd: 1,
    filmPath: "/tmp/should-not-appear/reel.mp4",
    shots: [{ index: 1, title: "A", status: "completed", prompt: "CANARY_PROMPT" }],
  }));
  return jobs;
}

afterEach(() => {
  if (originalJobs === undefined) delete process.env.THESHOW_JOBS_DIR;
  else process.env.THESHOW_JOBS_DIR = originalJobs;
  if (originalFeed === undefined) delete process.env.THESHOW_STUDIO_FEED;
  else process.env.THESHOW_STUDIO_FEED = originalFeed;
});

describe("studio feed guard", () => {
  it("accepts loopback peers and bracketed hosts, and rejects the rest", () => {
    expect(studioFeedRequestAllowed("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(studioFeedRequestAllowed("127.0.0.1", "127.0.0.1:3100")).toBe(true);
    expect(studioFeedRequestAllowed("127.0.0.1", "localhost:3100")).toBe(true);
    expect(studioFeedRequestAllowed("::1", "[::1]")).toBe(true);
    expect(studioFeedRequestAllowed("::1", "[::1]:3100")).toBe(true);
    expect(studioFeedRequestAllowed("::ffff:127.0.0.1", "localhost")).toBe(true);
    expect(studioFeedRequestAllowed("::ffff:127.0.0.1", "[::1]:80")).toBe(true);
    expect(studioFeedRequestAllowed("10.0.0.1", "127.0.0.1")).toBe(false);
    expect(studioFeedRequestAllowed("127.0.0.1", "evil.example")).toBe(false);
    expect(studioFeedRequestAllowed("127.0.0.1", "127.0.0.1.evil.example")).toBe(false);
    expect(studioFeedRequestAllowed("127.0.0.1", undefined)).toBe(false);
    expect(studioFeedRequestAllowed(undefined, "localhost")).toBe(false);
  });
});

describe("GET /api/production/feed", () => {
  it("serves the same feed as the module and refuses other methods and hosts", async () => {
    const jobs = await home();
    process.env.THESHOW_JOBS_DIR = jobs;
    const response = await request(app).get("/api/production/feed").set("Host", "127.0.0.1");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    const moduleFeed = await readProductionFeed({ jobsDir: jobs, limit: 20, now: Date.parse(response.body.generatedAt) });
    if ("refused" in moduleFeed) throw new Error(moduleFeed.reason);
    expect(response.body.jobs).toEqual(moduleFeed.jobs);
    expect(response.body.events.map((event: { id: string }) => event.id)).toEqual(moduleFeed.events.map((event) => event.id));
    expect(JSON.stringify(response.body)).not.toContain("CANARY_PROMPT");
    expect(JSON.stringify(response.body)).not.toContain("/tmp/should-not-appear");
    expect(response.body.jobs[0].filmPath).toBe("reel.mp4");

    const head = await request(app).head("/api/production/feed").set("Host", "127.0.0.1");
    expect(head.status).toBe(200);

    const posted = await request(app).post("/api/production/feed").set("Host", "127.0.0.1").send({});
    expect(posted.status).toBe(405);
    const put = await request(app).put("/api/production/feed").set("Host", "127.0.0.1");
    expect(put.status).toBe(405);
    const deleted = await request(app).delete("/api/production/feed").set("Host", "127.0.0.1");
    expect(deleted.status).toBe(405);

    const foreign = await request(app).get("/api/production/feed").set("Host", "evil.example");
    expect(foreign.status).toBe(404);

    const badId = await request(app).get("/api/production/feed").query({ jobId: "../x" }).set("Host", "127.0.0.1");
    expect(badId.status).toBe(400);

    process.env.THESHOW_STUDIO_FEED = "0";
    const disabled = await request(app).get("/api/production/feed").set("Host", "127.0.0.1");
    expect(disabled.status).toBe(404);

    const names = await readdir(jobs);
    expect(names.filter((name) => name.endsWith(".json"))).toEqual(["seq_route_film.json"]);
  });

  it("does not change files under the jobs directory", async () => {
    const jobs = await home();
    const tornLog = path.join(jobs, ".events", "seq_route_film.jsonl");
    await mkdir(path.dirname(tornLog), { recursive: true });
    await writeFile(tornLog, "{\"torn\":");
    await writeFile(path.join(jobs, "orphan.tmp"), "keep");
    process.env.THESHOW_JOBS_DIR = jobs;
    const stamp = async (file: string) => {
      const info = await stat(file);
      const bytes = await readFile(file);
      return `${info.mtimeMs}:${createHash("sha256").update(bytes).digest("hex")}`;
    };
    const files = [path.join(jobs, "seq_route_film.json"), tornLog, path.join(jobs, "orphan.tmp")];
    const before = await Promise.all(files.map(stamp));
    for (let i = 0; i < 20; i += 1) {
      const response = await request(app).get("/api/production/feed").set("Host", "127.0.0.1");
      expect(response.status).toBe(200);
    }
    const after = await Promise.all(files.map(stamp));
    expect(after).toEqual(before);
  });
});

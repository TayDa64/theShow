/**
 * Recovery against the built stdio and HTTP bundles.
 * Both processes run under the provider network guard. HTTP calls go to the
 * bundle's /mcp port. A restart kills the process and starts a new one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deriveJobEvents, parseEventLog } from "../mcp/jobEvents.ts";
import { readProductionFeed } from "../mcp/productionFeed.ts";
import { waitForChildClose, waitForChildSignal } from "./child-signal.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STDIO_BUNDLE = path.join(ROOT, "mcp", "server.bundle.mjs");
const HTTP_BUNDLE = path.join(ROOT, "mcp", "server-http.bundle.mjs");
const GUARD = path.join(ROOT, "tests", "provider-net-guard.mjs");
const TOKEN = "test-token-not-a-secret";
const PROTOCOL = "2025-11-25";
const ACCEPT = "application/json, text/event-stream";

const children: ChildProcess[] = [];

type Transport = "stdio" | "http";

function film(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    startedAt: 1_700_000_000_000,
    state: "completed",
    finishedAt: 1_700_000_000_050,
    shotCount: 1,
    completed: 1,
    estimateUsd: 1,
    spentUsd: 1,
    shots: [{ index: 1, title: "A", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      fadeDuration: 0,
      assemble: false,
      pin: "start",
    },
    ...extra,
  });
}

async function homeDir(): Promise<{ home: string; jobs: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "theshow-p3-bundle-"));
  const jobs = path.join(home, "jobs");
  await mkdir(jobs, { recursive: true });
  await mkdir(path.join(home, "media"), { recursive: true });
  await mkdir(path.join(home, "characters"), { recursive: true });
  await mkdir(path.join(home, "consistency"), { recursive: true });
  return { home, jobs };
}

function bundleEnv(home: string, transport: Transport, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    THESHOW_CONSISTENCY_DIR: path.join(home, "consistency"),
    GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
    THESHOW_FORBID_HOME_AUTH: "1",
    THESHOW_NET_GUARD_FILE: path.join(home, "net-guard.log"),
    THESHOW_JOB_LEASE_MS: "600000",
    NODE_OPTIONS: `--import ${pathToFileURL(GUARD).href}`,
    ...extra,
  };
  if (transport === "http") {
    env.THESHOW_TRANSPORT = "http";
    env.THESHOW_HTTP_TOKEN = TOKEN;
    env.THESHOW_HTTP_HOST = "127.0.0.1";
    env.THESHOW_HTTP_PORT = "0";
  }
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

class Bundle {
  readonly child: ChildProcess;
  readonly transport: Transport;
  stderr = "";
  private buffer = Buffer.alloc(0);
  private readonly inbox: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
  private readonly waiters: Array<(message: { id?: number; result?: unknown; error?: unknown }) => void> = [];
  private nextId = 0;
  private endpoint = "";
  private sessionId = "";

  constructor(home: string, transport: Transport, extra: Record<string, string> = {}) {
    this.transport = transport;
    const script = transport === "stdio" ? STDIO_BUNDLE : HTTP_BUNDLE;
    this.child = spawn(process.execPath, [script], {
      cwd: ROOT,
      detached: true,
      stdio: transport === "stdio" ? ["pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
      env: bundleEnv(home, transport, extra),
    });
    children.push(this.child);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const index = this.buffer.indexOf(0x0a);
        if (index === -1) break;
        const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
        this.buffer = this.buffer.subarray(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.inbox.push(message);
      }
    });
  }

  async ready(): Promise<void> {
    if (this.transport === "http") {
      const started = Date.now();
      while (!/running on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(this.stderr)) {
        if (this.child.exitCode !== null) throw new Error(this.stderr);
        if (Date.now() - started > 20_000) throw new Error(this.stderr);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const match = this.stderr.match(/running on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      if (!match?.[1]) throw new Error(this.stderr);
      this.endpoint = match[1];
      const initialized = await this.post({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "phase3-recovery", version: "0.0.0" },
        },
      });
      if (!initialized.sessionId) throw new Error(initialized.text);
      this.sessionId = initialized.sessionId;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return;
    }
    await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "phase3-recovery", version: "0.0.0" },
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.transport === "http") {
      const response = await this.post({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (response.json?.error) throw new Error(`${name} ${JSON.stringify(response.json.error)}\n${this.stderr}`);
      return response.json?.result;
    }
    return this.request("tools/call", { name, arguments: args });
  }

  kill(): void {
    const pid = this.child.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out\n${this.stderr}`)), 30_000);
      timer.unref();
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error(`${method} ended because the bundle exited`));
      };
      this.child.once("close", onClose);
      const onMessage = (message: { id?: number; result?: unknown; error?: unknown }) => {
        if (message.id !== id) {
          this.inbox.push(message);
          this.waiters.push(onMessage);
          return;
        }
        clearTimeout(timer);
        this.child.off("close", onClose);
        if (message.error) reject(new Error(`${method} ${JSON.stringify(message.error)}\n${this.stderr}`));
        else resolve(message.result);
      };
      const queued = this.inbox.findIndex((message) => message.id === id);
      if (queued !== -1) {
        const [message] = this.inbox.splice(queued, 1);
        onMessage(message!);
        return;
      }
      this.waiters.push(onMessage);
    });
  }

  private async post(body: unknown): Promise<{ sessionId: string | null; json: { error?: unknown; result?: unknown } | null; text: string }> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Accept: ACCEPT,
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId, "MCP-Protocol-Version": PROTOCOL } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      sessionId: response.headers.get("mcp-session-id"),
      json: text ? JSON.parse(text) as { error?: unknown; result?: unknown } : null,
      text,
    };
  }
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return (content[0] as { text?: string } | undefined)?.text ?? "";
}

function toolBody(result: unknown): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

async function assertGuard(home: string, script: string): Promise<void> {
  const log = await readFile(path.join(home, "net-guard.log"), "utf8");
  expect(log).toContain("guard-loaded");
  expect(log).toContain(script);
  expect(log).not.toContain("provider network blocked");
}

function normalizeText(text: string, home: string): string {
  const body = JSON.parse(text) as { jobId?: unknown };
  let out = text.split(home).join("<HOME>");
  if (typeof body.jobId === "string" && !body.jobId.startsWith("seq_p3_")) out = out.split(body.jobId).join("<JOB>");
  return out.replace(/\b\d{13,}\b/g, "<TIME>");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }
    await waitForChildClose(child);
  }
});

describe("phase 3 recovery on built bundles", () => {
  it.each(["stdio", "http"] as const)("kills the owner mid-append on %s and keeps the torn prefix", async (transport) => {
    const { home, jobs } = await homeDir();
    const id = `seq_p3_hold_${transport}`;
    const runningId = `seq_p3_hold_running_${transport}`;
    await writeFile(path.join(jobs, `${id}.json`), film(id));
    await writeFile(path.join(jobs, `${runningId}.json`), film(runningId, {
      state: "running",
      completed: 0,
      finishedAt: undefined,
      shots: [],
      owner: { pid: 999_999, token: "gone", host: "other-host", heartbeatAt: 1 },
    }));
    const owner = new Bundle(home, transport, { THESHOW_EVENT_APPEND_PROBE: "hold" });
    await owner.ready();
    const pending = owner.call("review_continuity", { jobId: id }).catch(() => undefined);
    await waitForChildSignal(owner.child, () => owner.stderr, "event-append-hold", 20_000);
    const torn = await readFile(path.join(jobs, ".events", `${id}.jsonl`));
    expect(torn.toString("utf8")).toBe("{\"partial\"");
    const written = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { continuityReview?: { version: number } };
    expect(written.continuityReview?.version).toBe(1);
    owner.kill();
    await waitForChildClose(owner.child);
    await pending;

    const next = new Bundle(home, transport);
    await next.ready();
    const reaped = JSON.parse(await readFile(path.join(jobs, `${runningId}.json`), "utf8")) as { state: string };
    expect(reaped.state).toBe("stopped");
    await expect(readFile(path.join(jobs, ".events", `${runningId}.jsonl`))).rejects.toThrow();
    const repaired = toolBody(await next.call("propose_repair", { jobId: id, badShot: 1, budgetUsd: 3 }));
    expect(repaired.persisted).toBe(true);
    const log = await readFile(path.join(jobs, ".events", `${id}.jsonl`));
    expect(log.subarray(0, torn.byteLength)).toEqual(torn);
    expect(log.toString("utf8").startsWith("{\"partial\"\n")).toBe(true);
    const parsed = parseEventLog(log.toString("utf8"), id);
    expect(parsed.tornLines).toBe(1);
    expect(parsed.events.some((event) => event.type === "repair.proposed")).toBe(true);
    next.kill();
    await assertGuard(home, transport === "stdio" ? "server.bundle.mjs" : "server-http.bundle.mjs");
  }, 60_000);

  it.each(["stdio", "http"] as const)("reconciles a kill between rename and append on %s", async (transport) => {
    const { home, jobs } = await homeDir();
    const id = `seq_p3_gap_${transport}`;
    await writeFile(path.join(jobs, `${id}.json`), film(id));
    const owner = new Bundle(home, transport, { THESHOW_EVENT_APPEND_PROBE: "gap" });
    await owner.ready();
    const pending = owner.call("review_continuity", { jobId: id }).catch(() => undefined);
    await waitForChildSignal(owner.child, () => owner.stderr, "event-append-hold", 20_000);
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    owner.kill();
    await waitForChildClose(owner.child);
    await pending;
    const next = new Bundle(home, transport);
    await next.ready();
    const repaired = toolBody(await next.call("propose_repair", { jobId: id, badShot: 1, budgetUsd: 2 }));
    expect(repaired.persisted).toBe(true);
    const parsed = parseEventLog(await readFile(path.join(jobs, ".events", `${id}.jsonl`), "utf8"), id);
    const ids = parsed.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    const disk = JSON.parse(await readFile(path.join(jobs, `${id}.json`), "utf8")) as { id: string };
    expect(ids).toContain(deriveJobEvents(disk).find((event) => event.type === "review.recorded")?.id);
    next.kill();
    await assertGuard(home, transport === "stdio" ? "server.bundle.mjs" : "server-http.bundle.mjs");
  }, 60_000);

  it.each(["stdio", "http"] as const)("shows owner-gone, then a reconciled stop after the bundle reaps on %s", async (transport) => {
    const { home, jobs } = await homeDir();
    const id = `seq_p3_gone_${transport}`;
    await writeFile(path.join(jobs, `${id}.json`), film(id, {
      state: "running",
      completed: 0,
      finishedAt: undefined,
      shots: [],
      owner: { pid: 999_999, token: "gone", host: "other-host", heartbeatAt: 1 },
    }));
    const waiting = await readProductionFeed({ jobsDir: jobs, jobId: id, limit: 20 });
    if ("refused" in waiting) throw new Error(waiting.reason);
    expect(waiting.jobs[0]?.liveness).toBe("owner-gone-awaiting-reap");
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    const bundle = new Bundle(home, transport);
    await bundle.ready();
    const before = toolBody(await bundle.call("production_feed", { jobId: id, limit: 20 }));
    const jobsBefore = before.jobs as Array<{ liveness?: string; state?: string }>;
    expect(jobsBefore[0]?.state).toBe("stopped");
    expect(jobsBefore[0]?.liveness).toBe("idle");
    await expect(readFile(path.join(jobs, ".events", `${id}.jsonl`))).rejects.toThrow();
    const events = before.events as Array<{ type?: string; source?: string; id?: string }>;
    const stopped = events.find((event) => event.type === "job.stopped");
    expect(stopped?.source).toBe("reconciled");
    expect(stopped?.id).toBe(deriveJobEvents({ id, state: "stopped", shotCount: 1, shots: [] }).find((event) => event.type === "job.stopped")?.id);
    bundle.kill();
    await assertGuard(home, transport === "stdio" ? "server.bundle.mjs" : "server-http.bundle.mjs");
  }, 40_000);

  it("runs a stdio bundle and an HTTP bundle at the same time on one home", async () => {
    const { home, jobs } = await homeDir();
    const id = "seq_p3_turns";
    await writeFile(path.join(jobs, `${id}.json`), film(id));
    const stdio = new Bundle(home, "stdio");
    const http = new Bundle(home, "http");
    await Promise.all([stdio.ready(), http.ready()]);
    let sawReview = false;
    let sawRepair = false;
    let lastRepair = "";
    for (let round = 0; round < 6 && !(sawReview && sawRepair); round += 1) {
      const [review, repair] = await Promise.all([
        sawReview
          ? stdio.call("production_feed", { jobId: id, limit: 5 })
          : stdio.call("review_continuity", { jobId: id }),
        sawRepair
          ? http.call("production_feed", { jobId: id, limit: 5 })
          : http.call("propose_repair", { jobId: id, badShot: 1, budgetUsd: 3, resolution: "720p" }),
      ]);
      if (!sawReview && toolBody(review).persisted === true) sawReview = true;
      if (!sawRepair) {
        lastRepair = toolText(repair);
        if (toolBody(repair).persisted === true) sawRepair = true;
      }
    }
    expect(sawReview).toBe(true);
    expect(sawRepair, lastRepair).toBe(true);
    const parsed = parseEventLog(await readFile(path.join(jobs, ".events", `${id}.jsonl`), "utf8"), id);
    const ids = parsed.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.seqCollisions).toBe(0);
    expect(parsed.events.map((event) => event.seq)).toEqual(parsed.events.map((_, index) => index + 1));
    expect(parsed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["review.recorded", "repair.proposed", "budget.set"]));
    const stdioFeed = toolBody(await stdio.call("production_feed", { jobId: id, limit: 50 }));
    const httpFeed = toolBody(await http.call("production_feed", { jobId: id, limit: 50 }));
    const idsOf = (body: Record<string, unknown>) => (body.events as Array<{ id: string }>).map((event) => event.id).sort();
    expect(idsOf(stdioFeed)).toEqual(idsOf(httpFeed));
    stdio.kill();
    http.kill();
    await assertGuard(home, "server.bundle.mjs");
    await assertGuard(home, "server-http.bundle.mjs");
  }, 60_000);

  it("kills both bundles and the restarted processes replay the same cursor", async () => {
    const { home, jobs } = await homeDir();
    const id = "seq_p3_restart";
    await writeFile(path.join(jobs, `${id}.json`), film(id));
    const stdio = new Bundle(home, "stdio");
    const http = new Bundle(home, "http");
    await Promise.all([stdio.ready(), http.ready()]);
    expect(toolBody(await stdio.call("review_continuity", { jobId: id })).persisted).toBe(true);
    const fresh = toolBody(await http.call("production_feed", { jobId: id, limit: 50 }));
    const page = toolBody(await http.call("production_feed", { jobId: id, limit: 1 }));
    const cursor = page.cursor as string;
    const beforeIds = (fresh.events as Array<{ id: string }>).map((event) => event.id);
    stdio.kill();
    http.kill();
    await Promise.all([waitForChildClose(stdio.child), waitForChildClose(http.child)]);

    const stdio2 = new Bundle(home, "stdio");
    const http2 = new Bundle(home, "http");
    await Promise.all([stdio2.ready(), http2.ready()]);
    const again = toolBody(await stdio2.call("production_feed", { jobId: id, limit: 50 }));
    expect((again.events as Array<{ id: string }>).map((event) => event.id)).toEqual(beforeIds);
    const replay = toolBody(await http2.call("production_feed", { jobId: id, limit: 1, cursor }));
    const replayAgain = toolBody(await http2.call("production_feed", { jobId: id, limit: 1, cursor }));
    expect(replayAgain.events).toEqual(replay.events);
    stdio2.kill();
    http2.kill();
    await assertGuard(home, "server.bundle.mjs");
    await assertGuard(home, "server-http.bundle.mjs");
  }, 60_000);

  it.each(["stdio", "http"] as const)("keeps tool text byte-identical when the append fails on %s", async (transport) => {
    const baseline = await homeDir();
    const id = `seq_p3_fail_${transport}`;
    await writeFile(path.join(baseline.jobs, `${id}.json`), film(id));
    const good = new Bundle(baseline.home, transport, {
      NODE_ENV: "test",
      THESHOW_STUB_VIDEO: "completed",
    });
    await good.ready();
    const goodReview = toolText(await good.call("review_continuity", { jobId: id }));
    const goodRepair = toolText(await good.call("propose_repair", { jobId: id, badShot: 1, budgetUsd: 4 }));
    const goodRender = toolText(await good.call("render_sequence", {
      shots: [{ prompt: "A lantern sits on a wooden table.", durationSeconds: 4, title: "Lantern" }],
      confirm: true,
      overrideValidation: true,
      assemble: false,
    }));
    expect(goodRender).toContain("jobId");
    good.kill();

    const failed = await homeDir();
    await writeFile(path.join(failed.jobs, `${id}.json`), film(id));
    await writeFile(path.join(failed.jobs, ".events"), "not-a-directory");
    const bad = new Bundle(failed.home, transport, {
      NODE_ENV: "test",
      THESHOW_STUB_VIDEO: "completed",
    });
    await bad.ready();
    const badReview = toolText(await bad.call("review_continuity", { jobId: id }));
    const badRepair = toolText(await bad.call("propose_repair", { jobId: id, badShot: 1, budgetUsd: 4 }));
    const badRender = toolText(await bad.call("render_sequence", {
      shots: [{ prompt: "A lantern sits on a wooden table.", durationSeconds: 4, title: "Lantern" }],
      confirm: true,
      overrideValidation: true,
      assemble: false,
    }));
    expect(normalizeText(badReview, failed.home)).toBe(normalizeText(goodReview, baseline.home));
    expect(normalizeText(badRepair, failed.home)).toBe(normalizeText(goodRepair, baseline.home));
    expect(normalizeText(badRender, failed.home)).toBe(normalizeText(goodRender, baseline.home));
    const lines = bad.stderr.split("\n").filter((line) => line.includes("event log append failed"));
    expect(lines.filter((line) => line.includes(id))).toHaveLength(1);
    expect(lines).toHaveLength(2);
    bad.kill();
    await assertGuard(failed.home, transport === "stdio" ? "server.bundle.mjs" : "server-http.bundle.mjs");
  }, 90_000);
});

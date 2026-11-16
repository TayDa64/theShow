/**
 * The same advisory call through the stdio process and the HTTP process.
 * Neither process renders. No bot is started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCH = path.join(ROOT, "mcp", "launch.mjs");
const TOKEN = "test-token-not-a-secret";

function baseEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_MCP_FROM_SOURCE: "1",
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    THESHOW_CONSISTENCY_DIR: path.join(home, "consistency"),
    GROK_AUTH_FILE: path.join(home, "no-auth.json"),
    THESHOW_FORBID_HOME_AUTH: "1",
    ...extra,
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function film(id: string): string {
  return JSON.stringify({
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
  });
}

class StdioClient {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private readonly inbox: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
  private readonly waiters: Array<(message: { id?: number; result?: unknown; error?: unknown }) => void> = [];
  private nextId = 0;
  stderr = "";

  constructor(home: string) {
    this.child = spawn(process.execPath, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: baseEnv(home),
    });
    this.child.stderr?.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
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

  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const message = await this.waitFor((candidate) => candidate.id === id);
    if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}\n${this.stderr}`);
    return message.result;
  }

  notify(method: string): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  stop(): void {
    const pid = this.child.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { this.child.kill("SIGTERM"); }
  }

  private waitFor(matches: (message: { id?: number }) => boolean): Promise<{ id?: number; result?: unknown; error?: unknown }> {
    const queued = this.inbox.findIndex(matches);
    if (queued !== -1) {
      const [message] = this.inbox.splice(queued, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio timed out\n${this.stderr}`)), 20_000);
      const onMessage = (message: { id?: number; result?: unknown; error?: unknown }) => {
        if (!matches(message)) {
          this.inbox.push(message);
          this.waiters.push(onMessage);
          return;
        }
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push(onMessage);
    });
  }
}

async function httpEndpoint(home: string): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [LAUNCH], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: baseEnv(home, {
      THESHOW_TRANSPORT: "http",
      THESHOW_HTTP_HOST: "127.0.0.1",
      THESHOW_HTTP_PORT: "0",
      THESHOW_HTTP_TOKEN: TOKEN,
    }),
  });
  let stderr = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`http did not start\n${stderr}`)), 20_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/theShow MCP server running on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`http exited ${code}\n${stderr}`));
    });
  });
  return {
    url,
    stop: () => {
      const pid = child.pid;
      if (!pid) return;
      try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    },
  };
}

async function httpCall(url: string, name: string, args: unknown): Promise<unknown> {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "phase2-http", version: "0.0.0" },
      },
    }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  const authed = { ...headers, "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-11-25" };
  await fetch(url, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const called = await fetch(url, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await called.json() as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
}

function textOf(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
  return JSON.parse(content?.[0]?.text ?? "{}");
}

describe("phase 2 stdio and http", () => {
  it("returns the same advisory result on both processes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "theshow-phase2-transport-"));
    await mkdir(path.join(home, "jobs"), { recursive: true });
    await writeFile(path.join(home, "no-auth.json"), "{}\n");
    await writeFile(path.join(home, "jobs", "seq_phase2_stdio.json"), film("seq_phase2_stdio"));
    await writeFile(path.join(home, "jobs", "seq_phase2_http.json"), film("seq_phase2_http"));
    const coverageArgs = {
      beats: [
        { title: "Establishing", shotType: "wide", locationId: "kitchen", durationSeconds: 8 },
        { title: "Look", shotType: "medium", locationId: "kitchen", durationSeconds: 8 },
      ],
    };
    const crossArgs = { jobIds: ["seq_phase2_stdio", "seq_phase2_http"] };
    const stdio = new StdioClient(home);
    const http = await httpEndpoint(home);
    try {
      await stdio.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "phase2-stdio", version: "0.0.0" },
      });
      stdio.notify("notifications/initialized");
      const listed = await stdio.request("tools/list", {}) as { tools?: Array<{ name: string }> };
      const names = listed.tools?.map((tool) => tool.name) ?? [];
      expect(names.slice(-2)).toEqual(["suggest_coverage", "check_cross_film"]);
      const stdioCoverage = textOf(await stdio.request("tools/call", { name: "suggest_coverage", arguments: coverageArgs }));
      const httpCoverage = await httpCall(http.url, "suggest_coverage", coverageArgs);
      expect(httpCoverage).toEqual(stdioCoverage);
      const stdioCross = textOf(await stdio.request("tools/call", { name: "check_cross_film", arguments: crossArgs }));
      const httpCross = await httpCall(http.url, "check_cross_film", crossArgs);
      expect(httpCross).toEqual(stdioCross);
      expect(JSON.stringify(stdioCross)).not.toContain("costQuote");
      expect(stdio.stderr).not.toContain("running on http");
    } finally {
      stdio.stop();
      http.stop();
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

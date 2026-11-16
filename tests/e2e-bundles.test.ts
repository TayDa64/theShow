/**
 * End-to-end calls against the built bundles, over stdio and HTTP.
 * The processes are production-like: no NODE_ENV=test and no THESHOW_STUB_VIDEO.
 * A preload records outbound network and refuses anything off loopback, because
 * the server has no provider base-URL override.
 *
 * Normalized before stdio/HTTP compare (run-specific only):
 * - the temp home prefix
 * - frame-<12 hex> and film-<12 hex> names (they include Date.now())
 * - cxf_<uuid> report ids
 * - char_<time>_<hash> ids from create_character
 * - ISO timestamps from 2026 onward (create_character createdAt/updatedAt)
 * - epoch milliseconds above 1_750_000_000_000 (a reaped job's finishedAt, if echoed)
 * - configure_film.message, which the audit shows is transport-specific
 *   (stdio has no form; HTTP has no SSE stream). That field is asserted on its own.
 * - the no-credential refusal text. Stdio says no credential was found. HTTP
 *   refuses the subscription session and names XAI_API_KEY. Both are refusals
 *   before a provider request; the wording is asserted per transport.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTools } from "../mcp/media.ts";
import { sweepOrphanTemps, sweepStaleReviewFrames } from "../mcp/runtime.ts";
import { assertGuardLog, type GuardedProcess } from "./guard-log.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LAUNCH = path.join(ROOT, "mcp", "launch.mjs");
const GUARD = path.join(ROOT, "tests", "provider-net-guard.mjs");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "mcp-tool-input-schemas.json");
const TOKEN = "test-token-not-a-secret";
const PROTOCOL = "2025-11-25";
const ACCEPT = "application/json, text/event-stream";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const FROZEN = new Date("2020-01-01T00:00:00.000Z");

const TOOL_ORDER = [
  "configure_film",
  "create_character",
  "plan_storyboard",
  "generate_controlled_clip",
  "extend_clip",
  "extract_last_frame",
  "generate_still",
  "assemble_film",
  "render_sequence",
  "board_film",
  "retry_shot",
  "list_films",
  "check_sequence",
  "review_continuity",
  "propose_repair",
  "suggest_coverage",
  "check_cross_film",
] as const;

type JsonRpc = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type ListedTool = { name: string; description?: string; inputSchema?: unknown };

const openHomes: Array<{ pid?: number; home: string }> = [];

afterEach(async () => {
  for (const item of openHomes.splice(0)) {
    if (item.pid) {
      try { process.kill(-item.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await rm(item.home, { recursive: true, force: true });
  }
});

function bundleEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    THESHOW_CONSISTENCY_DIR: path.join(home, "consistency"),
    GROK_AUTH_FILE: path.join(home, "missing-auth.json"),
    THESHOW_FORBID_HOME_AUTH: "1",
    THESHOW_NET_GUARD_FILE: path.join(home, "net-guard.log"),
    // A foreign-host running owner is kept until its lease ends. The suite
    // holds that file still-running, so the lease has to outlast the calls.
    THESHOW_JOB_LEASE_MS: "600000",
    NODE_OPTIONS: `--import ${pathToFileURL(GUARD).href}`,
    ...extra,
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.NODE_ENV;
  delete env.THESHOW_STUB_VIDEO;
  delete env.THESHOW_MCP_FROM_SOURCE;
  return env;
}

async function waitUntil(label: string, ready: () => boolean, ceilingMs: number): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started >= ceilingMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

class StdioBundle {
  readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private readonly inbox: JsonRpc[] = [];
  private readonly waiters: Array<(message: JsonRpc) => void> = [];
  private nextId = 0;
  stderr = "";

  constructor(home: string) {
    this.child = spawn(process.execPath, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: bundleEnv(home),
    });
    openHomes.push({ pid: this.child.pid, home });
    this.child.stderr?.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const index = this.buffer.indexOf(0x0a);
        if (index === -1) break;
        const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
        this.buffer = this.buffer.subarray(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpc;
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.inbox.push(message);
      }
    });
  }

  async ready(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "theshow-e2e-stdio", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
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

  /** Start a call and do not wait. Used to kill the process while it is blocked. */
  beginCall(name: string, args: Record<string, unknown>): void {
    const id = ++this.nextId;
    this.child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  async listTools(): Promise<ListedTool[]> {
    const listed = await this.request("tools/list", {}) as { tools?: ListedTool[] };
    return listed.tools ?? [];
  }

  stop(): void {
    killGroup(this.child);
  }

  private waitFor(matches: (message: JsonRpc) => boolean): Promise<JsonRpc> {
    const queued = this.inbox.findIndex(matches);
    if (queued !== -1) {
      const [message] = this.inbox.splice(queued, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio timed out\n${this.stderr}`)), 30_000);
      const onMessage = (message: JsonRpc) => {
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

class HttpBundle {
  readonly child: ChildProcess;
  stderr = "";
  private endpoint = "";
  private sessionId = "";
  private nextId = 0;

  constructor(home: string) {
    this.child = spawn(process.execPath, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: bundleEnv(home, {
        THESHOW_TRANSPORT: "http",
        THESHOW_HTTP_TOKEN: TOKEN,
        THESHOW_HTTP_PORT: "0",
      }),
    });
    openHomes.push({ pid: this.child.pid, home });
    this.child.stderr?.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  async ready(): Promise<void> {
    await waitUntil("http listen", () => /running on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(this.stderr), 30_000);
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
        clientInfo: { name: "theshow-e2e-http", version: "0.0.0" },
      },
    });
    if (!initialized.sessionId) throw new Error(`no session\n${initialized.text}`);
    this.sessionId = initialized.sessionId;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (response.json?.error) throw new Error(`${name} failed: ${JSON.stringify(response.json.error)}\n${this.stderr}`);
    return response.json?.result;
  }

  /** Start a call and do not wait. The returned promise rejects when the process dies. */
  beginCall(name: string, args: Record<string, unknown>): void {
    void this.post({
      jsonrpc: "2.0",
      id: ++this.nextId,
      method: "tools/call",
      params: { name, arguments: args },
    }).catch(() => undefined);
  }

  async listTools(): Promise<ListedTool[]> {
    const response = await this.post({ jsonrpc: "2.0", id: ++this.nextId, method: "tools/list", params: {} });
    const tools = (response.json?.result as { tools?: ListedTool[] } | undefined)?.tools ?? [];
    return tools;
  }

  stop(): void {
    killGroup(this.child);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${TOKEN}`,
      "Mcp-Session-Id": this.sessionId,
      "MCP-Protocol-Version": PROTOCOL,
    };
  }

  private async post(body: unknown): Promise<{ status: number; sessionId: string | null; json: JsonRpc | null; text: string }> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Accept: ACCEPT,
        "Content-Type": "application/json",
        ...(this.sessionId ? this.headers() : { Authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      sessionId: response.headers.get("mcp-session-id"),
      json: text ? JSON.parse(text) as JsonRpc : null,
      text,
    };
  }
}

type BundleClient = StdioBundle | HttpBundle;

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

function toolJson(result: unknown): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

function spendKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) spendKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "costQuote" || key === "confirm" || key.startsWith("approved")) found.push(key);
    spendKeys(child, found);
  }
  return found;
}

function normalize(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    if (value.includes("No credential") || value.includes("HTTP mode bills XAI_API_KEY")) {
      return "<CREDENTIAL_REFUSAL>";
    }
    return value
      .split(home).join("<HOME>")
      .replace(/frame-[a-f0-9]{12}/g, "frame-<id>")
      .replace(/film-[a-f0-9]{12}/g, "film-<id>")
      .replace(/cxf_[0-9a-f-]{36}/g, "cxf_<id>")
      .replace(/char_[a-z0-9]+_[a-f0-9]+/g, "char_<id>")
      .replace(/20(?:2[6-9]|[3-9]\d)-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIME>");
  }
  if (typeof value === "number") {
    return value > 1_750_000_000_000 ? "<NOW>" : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, home));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "message" && "elicitationSupported" in source) continue;
    out[key] = normalize(child, home);
  }
  return out;
}

async function stamp(file: string): Promise<string> {
  const info = await stat(file, { bigint: true });
  try {
    const bytes = await readFile(file);
    return `${createHash("sha256").update(bytes).digest("hex")}:${info.mtimeNs.toString()}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") return `unreadable:${info.mtimeNs.toString()}`;
    throw err;
  }
}

async function fingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    names.sort();
    for (const name of names) {
      const full = path.join(current, name);
      const info = await stat(full);
      const rel = path.relative(dir, full);
      if (info.isDirectory()) {
        out[`${rel}/`] = "dir";
        await walk(full);
      } else {
        out[rel] = await stamp(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function freezeTree(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) await freezeTree(full);
    else await utimes(full, FROZEN, FROZEN);
  }
}

function watched(home: string): string[] {
  return ["jobs", "characters", "media", "consistency"].map((name) => path.join(home, name));
}

async function snapshotHome(home: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const dir of watched(home)) out[path.basename(dir)] = await fingerprint(dir);
  return out;
}

function bundleProcesses(rootPid: number): GuardedProcess[] {
  const found: GuardedProcess[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    let children = "";
    try {
      children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      children = "";
    }
    for (const part of children.trim().split(/\s+/)) {
      if (part) stack.push(Number(part));
    }
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
      const script = args
        .map((arg) => path.basename(arg))
        .find((name) => name === "server.bundle.mjs" || name === "server-http.bundle.mjs");
      if (script) found.push({ pid, script });
    } catch {
      // The process can exit between the walk and the read.
    }
  }
  return found;
}

function requireBundle(rootPid: number, script: string): GuardedProcess {
  const found = bundleProcesses(rootPid).filter((item) => item.script === script);
  if (found.length !== 1) {
    const listed = found.map((item) => String(item.pid)).join(", ");
    throw new Error(`expected one ${script} under pid ${rootPid}, found ${listed || "none"}`);
  }
  return found[0];
}

function pidsHolding(rootPid: number, target: string): number[] {
  const found: number[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const part of children.trim().split(/\s+/)) {
        if (part) stack.push(Number(part));
      }
    } catch {
      continue;
    }
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) found.push(pid);
        } catch {
          // The fd can close between readdir and readlink.
        }
      }
    } catch {
      // The process can exit between checks.
    }
  }
  return found;
}

function film(id: string, startedAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startedAt,
    state: "completed",
    shotCount: 1,
    completed: 1,
    estimateUsd: 0.56,
    spentUsd: 0.56,
    shots: [{
      index: 1,
      title: "Lantern",
      status: "completed",
      prompt: "A lantern sits on a wooden table.",
      durationSeconds: 4,
      shotType: "wide",
    }],
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      fadeDuration: 0,
      assemble: false,
      pin: "start",
      characters: ["Ada"],
    },
    ...extra,
  };
}

async function seedHome(home: string): Promise<{ clip: string; jobs: Record<string, string> }> {
  const jobs = path.join(home, "jobs");
  const media = path.join(home, "media");
  const characters = path.join(home, "characters", "ada");
  const consistency = path.join(home, "consistency");
  await mkdir(jobs, { recursive: true });
  await mkdir(media, { recursive: true });
  await mkdir(characters, { recursive: true });
  await mkdir(consistency, { recursive: true });
  await mkdir(path.join(jobs, ".spend-journal", "seq_e2e_phase1"), { recursive: true });
  const clip = path.join(media, "lantern.mp4");
  const still = path.join(media, "lantern.png");
  const { ffmpeg } = await resolveTools();
  await execFileAsync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "1", clip]);
  await writeFile(still, PNG);
  await writeFile(path.join(characters, "portrait.png"), PNG);
  await writeFile(path.join(characters, "character.json"), JSON.stringify({
    id: "char_ada_fixture",
    name: "Ada",
    updatedAt: "2024-06-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    referenceImageUrls: [path.join(characters, "portrait.png")],
  }, null, 2));
  const bodies: Record<string, Record<string, unknown>> = {
    seq_e2e_legacy: film("seq_e2e_legacy", 1_700_000_000_000, {
      shots: [{
        index: 1,
        title: "Lantern",
        status: "completed",
        prompt: "A lantern sits on a wooden table.",
        durationSeconds: 4,
        localPath: clip,
        openingFramePath: still,
      }],
    }),
    seq_e2e_phase1: film("seq_e2e_phase1", 1_700_100_000_000, {
      spendLedger: { version: 1, spentUsd: 0.56, pendingUsd: 0, appliedNoteIds: ["note-applied"] },
      ledger: {
        promptStyle: "legacy",
        props: [{ id: "lamp", locationId: "room", name: "lamp", placement: "on the table" }],
        shots: [{ shot: 1, locationId: "room", checklists: [{ character: "Ada", worn: [{ id: "coat" }] }] }],
      },
    }),
    seq_e2e_phase2: film("seq_e2e_phase2", 1_700_200_000_000, {
      characterSnapshots: [{
        name: "Ada",
        updatedAt: "2024-06-01T00:00:00.000Z",
        references: [{ path: path.join(characters, "portrait.png"), sha256: createHash("sha256").update(PNG).digest("hex") }],
      }],
    }),
    seq_e2e_resumed: film("seq_e2e_resumed", 1_700_300_000_000, {
      resumedFrom: { jobId: "seq_e2e_phase1", fromShot: 1 },
    }),
    seq_e2e_repaired: film("seq_e2e_repaired", 1_700_400_000_000, {
      repairedFrom: { jobId: "seq_e2e_resumed", shotIndex: 1, originalCostUsd: 0.56 },
    }),
    seq_e2e_running_remote: film("seq_e2e_running_remote", 1_700_500_000_000, {
      state: "running",
      completed: 0,
      owner: { pid: 2_000_000_001, token: "remote-owner", host: "remote-host-not-this-box", heartbeatAt: Date.now() },
    }),
    seq_e2e_running_local: film("seq_e2e_running_local", 1_700_600_000_000, {
      state: "running",
      completed: 0,
      owner: { pid: 2_000_000_002, token: "dead-local-owner", host: hostname(), heartbeatAt: Date.now() },
    }),
  };
  const written: Record<string, string> = {};
  for (const [id, body] of Object.entries(bodies)) {
    const file = path.join(jobs, `${id}.json`);
    const text = JSON.stringify(body, null, 2);
    await writeFile(file, text);
    written[id] = text;
  }
  await writeFile(
    path.join(jobs, ".spend-journal", "seq_e2e_phase1", "0000000000000001-note-queued.json"),
    JSON.stringify({ id: "note-queued", op: "spend", kind: "video", usd: 0.14, estimated: true }),
  );
  await freezeTree(home);
  return { clip, jobs: written };
}

const reviewShots = [
  { index: 1, worn: ["coat"], durationSeconds: 4, props: [{ id: "lamp", locationId: "room", placement: "on the table" }] },
  { index: 2, worn: ["coat"], durationSeconds: 4, props: [{ id: "lamp", locationId: "room", placement: "on the table" }] },
];

const repairShots = [
  { index: 1, durationSeconds: 4, pin: "start" as const },
  { index: 2, durationSeconds: 4, pin: "start" as const },
];

function advisoryCalls(): Array<{ name: string; args: Record<string, unknown>; readOnly: boolean }> {
  return [
    { name: "suggest_coverage", readOnly: true, args: { jobId: "seq_e2e_phase2" } },
    {
      name: "suggest_coverage",
      readOnly: true,
      args: {
        usedBuiltInLadder: false,
        beats: [
          { title: "Lantern", shotType: "wide", locationId: "room", durationSeconds: 4 },
          { title: "Close", shotType: "close-up", locationId: "room", durationSeconds: 4 },
        ],
      },
    },
    { name: "review_continuity", readOnly: true, args: { shots: reviewShots } },
    { name: "propose_repair", readOnly: true, args: { badShot: 1, shots: repairShots } },
    {
      name: "check_cross_film",
      readOnly: true,
      args: {
        jobIds: [
          "seq_e2e_legacy",
          "seq_e2e_phase1",
          "seq_e2e_phase2",
          "seq_e2e_resumed",
          "seq_e2e_repaired",
          "seq_e2e_running_remote",
          "seq_e2e_running_local",
        ],
      },
    },
    {
      name: "check_cross_film",
      readOnly: false,
      args: { jobIds: ["seq_e2e_legacy", "seq_e2e_phase2"], persist: true },
    },
  ];
}

async function productionCalls(clip: string): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  return [
    { name: "configure_film", args: {} },
    {
      name: "plan_storyboard",
      args: { sceneDescription: "A lantern sits on a wooden table.", characters: ["Ada"], shotCount: 2 },
    },
    { name: "list_films", args: { includeUnfinished: true, limit: 20 } },
    { name: "check_sequence", args: { jobId: "seq_e2e_legacy" } },
    { name: "generate_controlled_clip", args: { prompt: "A lantern sits on a wooden table.", durationSeconds: 4 } },
    { name: "extend_clip", args: { videoUrl: "https://example.test/clip.mp4", prompt: "The lantern keeps burning.", durationSeconds: 2 } },
    { name: "generate_still", args: { prompt: "A lantern sits on a wooden table." } },
    { name: "render_sequence", args: { shots: [{ prompt: "A lantern sits on a wooden table.", durationSeconds: 4, title: "Lantern" }] } },
    { name: "board_film", args: { shots: [{ prompt: "A lantern sits on a wooden table.", durationSeconds: 4 }], cast: "one person at a table" } },
    { name: "retry_shot", args: { jobId: "seq_e2e_legacy", shotIndex: 1 } },
    { name: "create_character", args: { name: "Nia", description: "Holds the lantern." } },
    { name: "extract_last_frame", args: { videoUrl: clip, includeDataUri: false } },
    { name: "assemble_film", args: { clips: [{ url: clip, title: "Lantern" }] } },
    {
      name: "extend_clip",
      args: {
        videoUrl: "https://example.test/clip.mp4",
        prompt: "The lantern keeps burning.",
        durationSeconds: 2,
        confirm: true,
        overrideValidation: true,
      },
    },
  ];
}

const QUOTE_TOOLS = new Set([
  "generate_controlled_clip",
  "extend_clip",
  "generate_still",
  "render_sequence",
  "board_film",
  "retry_shot",
]);

describe("built bundle end to end", () => {
  it("calls every tool on stdio and HTTP, keeps advisory reads stable, and makes no provider call", async () => {
    const stdioHome = await mkdtemp(path.join(tmpdir(), "theshow-e2e-stdio-"));
    const httpHome = await mkdtemp(path.join(tmpdir(), "theshow-e2e-http-"));
    const seededStdio = await seedHome(stdioHome);
    const seededHttp = await seedHome(httpHome);
    const stdio = new StdioBundle(stdioHome);
    const http = new HttpBundle(httpHome);
    try {
      await Promise.all([stdio.ready(), http.ready()]);
      const localJob = path.join(stdioHome, "jobs", "seq_e2e_running_local.json");
      const remoteJob = path.join(stdioHome, "jobs", "seq_e2e_running_remote.json");
      const reaped = JSON.parse(await readFile(localJob, "utf8")) as { state?: string; error?: string };
      expect(reaped.state).toBe("stopped");
      expect(reaped.error).toMatch(/server stopped while this film was rendering/i);
      expect(await readFile(remoteJob, "utf8")).toBe(seededStdio.jobs.seq_e2e_running_remote);

      const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };
      for (const client of [stdio, http]) {
        const tools = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER]);
        expect(tools.slice(0, fixture.tools.length).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))).toEqual(fixture.tools);
      }

      const stdioResults: Record<string, unknown>[] = [];
      const httpResults: Record<string, unknown>[] = [];
      const clients: Array<[BundleClient, string, Record<string, unknown>[], string]> = [
        [stdio, stdioHome, stdioResults, seededStdio.clip],
        [http, httpHome, httpResults, seededHttp.clip],
      ];

      for (const [client, home, results] of clients) {
        const before = await snapshotHome(home);
        for (const call of advisoryCalls()) {
          const body = toolJson(await client.call(call.name, call.args));
          results.push(body);
          expect(body.executed).toBe(false);
          expect(body.willRender).toBe(false);
          expect(body.willSpend).toBe(false);
          if (call.name === "suggest_coverage" || call.name === "check_cross_film") {
            expect(spendKeys(body)).toEqual([]);
            if (call.args.persist === true) {
              expect(body.mutatedPaths).toEqual([expect.stringMatching(/cxf_[0-9a-f-]+\.json$/)]);
            } else {
              expect(body.mutatedPaths).toEqual([]);
            }
          }
          const after = await snapshotHome(home);
          if (call.readOnly) {
            expect(after).toEqual(before);
          } else {
            expect(after.jobs).toEqual(before.jobs);
            expect(after.characters).toEqual(before.characters);
            expect(after.media).toEqual(before.media);
            const reports = Object.keys(after.consistency).filter((name) => name.endsWith(".json"));
            expect(reports).toHaveLength(1);
            expect(reports[0]).toMatch(/^cxf_[0-9a-f-]+\.json$/);
          }
        }
        expect(await readFile(path.join(home, "jobs", "seq_e2e_running_remote.json"), "utf8")).toBe(
          home === stdioHome ? seededStdio.jobs.seq_e2e_running_remote : seededHttp.jobs.seq_e2e_running_remote,
        );
      }

      for (const [client, , results, clip] of clients) {
        for (const call of await productionCalls(clip)) {
          const result = await client.call(call.name, call.args);
          const text = toolText(result);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch (err) {
            throw new Error(`${call.name} returned non-JSON: ${text.slice(0, 400)}\n${err instanceof Error ? err.message : String(err)}`);
          }
          results.push(body);
          const confirmed = call.args.confirm === true;
          if (QUOTE_TOOLS.has(call.name) && !confirmed) {
            expect(body.action).toBe("estimate-only");
            expect(body.costQuote).toEqual(expect.objectContaining({ usd: expect.any(Number) }));
            expect(body.requestId).toBeUndefined();
            expect(body.status).toBeUndefined();
          }
          if (confirmed) {
            // extend_clip asks whether the session can outlast the job before it
            // builds a provider request. With no credential that refusal is the
            // whole call: no request id and no api.x.ai URL.
            expect(body.action).toBe("refused");
            expect(String(body.error)).toMatch(/No credential|HTTP mode bills XAI_API_KEY/);
            expect(body.requestId).toBeUndefined();
            expect(JSON.stringify(body)).not.toMatch(/https:\/\/api\.x\.ai/);
          }
        }
      }

      expect(String(stdioResults.at(-1)?.error)).toMatch(/No credential found/);
      expect(String(httpResults.at(-1)?.error)).toMatch(/HTTP mode bills XAI_API_KEY/);
      expect(stdioResults.map((body) => normalize(body, stdioHome))).toEqual(
        httpResults.map((body) => normalize(body, httpHome)),
      );
      const stdioForm = stdioResults.find((body) => "elicitationSupported" in body);
      const httpForm = httpResults.find((body) => "elicitationSupported" in body);
      expect(String(stdioForm?.message)).toMatch(/cannot show an interactive form/);
      expect(String(httpForm?.message)).toMatch(/no server-to-client stream/);

      for (const home of [stdioHome, httpHome]) {
        const unreadable = path.join(home, "jobs", "seq_e2e_unreadable.json");
        const invalid = path.join(home, "jobs", "seq_e2e_invalid.json");
        // A directory is unreadable as a job file for every uid, including root.
        // chmod 0 is not: root can still read the file.
        await mkdir(unreadable);
        await writeFile(invalid, "{ \"id\": \"seq_e2e_invalid\", ");
      }
      for (const [client, home, script] of [
        [stdio, stdioHome, "server.bundle.mjs"],
        [http, httpHome, "server-http.bundle.mjs"],
      ] as const) {
        const body = toolJson(await client.call("check_cross_film", {
          jobIds: ["seq_e2e_unreadable", "seq_e2e_invalid", "seq_e2e_absent"],
        }));
        const findings = body.findings as Array<{ jobIds: string[]; evidence?: { artifactPaths: string[] }; summary: string }>;
        const cited = (id: string) => findings.find((item) => item.jobIds.includes(id));
        expect(cited("seq_e2e_unreadable")?.summary).toMatch(/unreadable/);
        expect(cited("seq_e2e_unreadable")?.evidence?.artifactPaths).toEqual([path.join(home, "jobs", "seq_e2e_unreadable.json")]);
        expect(cited("seq_e2e_invalid")?.evidence?.artifactPaths).toEqual([path.join(home, "jobs", "seq_e2e_invalid.json")]);
        expect(cited("seq_e2e_absent")?.summary).toBe("Job file not on disk.");
        expect(cited("seq_e2e_absent")?.evidence?.artifactPaths).toEqual([]);
        const launcher = client.child.pid;
        if (!launcher) throw new Error("missing launcher pid");
        assertGuardLog(
          await readFile(path.join(home, "net-guard.log"), "utf8").catch(() => ""),
          [requireBundle(launcher, script)],
        );
      }
    } finally {
      stdio.stop();
      http.stop();
    }
  }, 180_000);

  it.each(["stdio", "http"] as const)(
    "kills a %s bundle mid-call and the restarted bundle returns the same advisory result",
    async (transport) => {
      const home = await mkdtemp(path.join(tmpdir(), `theshow-e2e-kill-${transport}-`));
      await seedHome(home);
      const jobs = path.join(home, "jobs");
      const consistency = path.join(home, "consistency");
      const suggestFile = path.join(jobs, "seq_e2e_phase2.json");
      const crossFile = path.join(jobs, "seq_e2e_legacy.json");
      const suggestBytes = await readFile(suggestFile);
      const crossBytes = await readFile(crossFile);

      const bundles: GuardedProcess[] = [];
      const script = transport === "stdio" ? "server.bundle.mjs" : "server-http.bundle.mjs";

      async function start(): Promise<BundleClient> {
        const client = transport === "stdio" ? new StdioBundle(home) : new HttpBundle(home);
        await client.ready();
        const launcher = client.child.pid;
        if (!launcher) throw new Error("missing launcher pid");
        bundles.push(requireBundle(launcher, script));
        return client;
      }

      async function blockAndKill(file: string, bytes: Buffer, name: string, args: Record<string, unknown>): Promise<void> {
        const client = await start();
        const pid = client.child.pid;
        if (!pid) throw new Error("missing pid");
        await rm(file, { force: true });
        await execFileAsync("mkfifo", [file]);
        // Node opens the fifo, then readFile waits until the writer closes.
        // Holding the write end open is the mid-call signal. A writer-less
        // open returns ENXIO and the call would finish instead of blocking.
        let holderOut = "";
        let holderErr = "";
        const holder = spawn(process.execPath, ["--input-type=module", "-e", "import { openSync } from 'node:fs'; openSync(process.env.FIFO_PATH, 'w'); process.stdout.write('writer-open\\n'); setInterval(() => undefined, 1000);"], {
          env: { PATH: process.env.PATH, FIFO_PATH: file },
          stdio: ["ignore", "pipe", "pipe"],
        });
        holder.stdout?.setEncoding("utf8");
        holder.stderr?.setEncoding("utf8");
        holder.stdout?.on("data", (chunk: string) => { holderOut += chunk; });
        holder.stderr?.on("data", (chunk: string) => { holderErr += chunk; });
        client.beginCall(name, args);
        try {
          await waitUntil(`${name} is blocked reading ${path.basename(file)}`, () => holderOut.includes("writer-open"), 30_000);
        } catch (err) {
          holder.kill("SIGKILL");
          throw new Error(`${err instanceof Error ? err.message : String(err)}\n${holderErr}\n${client.stderr}`);
        }
        expect(pidsHolding(pid, file).length).toBeGreaterThan(0);
        client.stop();
        await new Promise<void>((resolve) => {
          if (client.child.exitCode !== null || client.child.signalCode !== null) resolve();
          else client.child.once("close", () => resolve());
        });
        holder.kill("SIGKILL");
        const reports = (await readdir(consistency)).filter((entry) => entry.endsWith(".json") && !entry.endsWith(".tmp"));
        expect(reports).toEqual([]);
        await sweepOrphanTemps(consistency);
        await sweepStaleReviewFrames(jobs);
        expect(await readdir(consistency)).toEqual([]);
        await rm(file, { force: true });
        await writeFile(file, bytes);
        expect(pidsHolding(pid, file)).toEqual([]);
      }

      await blockAndKill(suggestFile, suggestBytes, "suggest_coverage", { jobId: "seq_e2e_phase2" });
      await blockAndKill(crossFile, crossBytes, "check_cross_film", {
        jobIds: ["seq_e2e_legacy", "seq_e2e_phase2"],
        persist: true,
      });

      const restarted = await start();
      try {
        const suggestA = normalize(toolJson(await restarted.call("suggest_coverage", { jobId: "seq_e2e_phase2" })), home);
        const suggestB = normalize(toolJson(await restarted.call("suggest_coverage", { jobId: "seq_e2e_phase2" })), home);
        expect(suggestA).toEqual(suggestB);
        const crossA = normalize(toolJson(await restarted.call("check_cross_film", {
          jobIds: ["seq_e2e_legacy", "seq_e2e_phase2"],
          persist: true,
        })), home);
        const crossB = normalize(toolJson(await restarted.call("check_cross_film", {
          jobIds: ["seq_e2e_legacy", "seq_e2e_phase2"],
          persist: true,
        })), home);
        expect(crossA).toEqual(crossB);
        const reports = (await readdir(consistency)).filter((entry) => entry.endsWith(".json"));
        expect(reports.length).toBeGreaterThan(0);
        expect(reports.every((entry) => !entry.endsWith(".tmp"))).toBe(true);
        // suggest kill, cross-film kill, and the restarted server each load the guard.
        // The launcher's own marker does not count. Each recorded bundle pid does.
        expect(bundles).toHaveLength(3);
        assertGuardLog(await readFile(path.join(home, "net-guard.log"), "utf8").catch(() => ""), bundles);
      } finally {
        restarted.stop();
      }
    },
    120_000,
  );
});

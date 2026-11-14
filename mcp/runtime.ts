/**
 * Process identity, request scope, and small helpers shared by stdio and HTTP.
 *
 * Nothing here imports the MCP HTTP transport. The stdio bundle can use this
 * module without pulling that stack in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JOBS_DIR } from "./media";

export type JobOwner = {
  pid: number;
  token: string;
  host: string;
  heartbeatAt: number;
};

export type RequestScope = {
  kind: "stdio" | "http";
  /** True while this HTTP session has an open GET SSE stream. */
  sseConnected: boolean;
};

export const processToken = randomUUID();
export const processHost = hostname();

const scopeStore = new AsyncLocalStorage<RequestScope>();
const serverStore = new AsyncLocalStorage<McpServer>();
const renderBypass = new AsyncLocalStorage<true>();
const pendingWrites = new Set<Promise<void>>();
const renderInflight = new Map<string, Promise<unknown>>();
const renderDone = new Map<string, { at: number; value: unknown }>();

const RENDER_MEMORY_MS = 10 * 60 * 1000;

export function jobsDirectory(): string {
  return process.env.THESHOW_JOBS_DIR || JOBS_DIR;
}

export function leaseMs(): number {
  const raw = Number(process.env.THESHOW_JOB_LEASE_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 30_000;
}

export function heartbeatMs(): number {
  const raw = Number(process.env.THESHOW_JOB_HEARTBEAT_MS ?? 10_000);
  return Number.isFinite(raw) && raw >= 200 ? raw : 10_000;
}

export function elicitTimeoutMs(): number {
  const raw = Number(process.env.THESHOW_ELICIT_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(raw) && raw >= 200 ? raw : 10_000;
}

export function sessionTtlMs(): number {
  const raw = Number(process.env.THESHOW_HTTP_SESSION_TTL_MS ?? 30 * 60 * 1000);
  return Number.isFinite(raw) && raw >= 200 ? raw : 30 * 60 * 1000;
}

export function maxSessions(): number {
  const raw = Number(process.env.THESHOW_HTTP_MAX_SESSIONS ?? 32);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 32;
}

export function thisOwner(now = Date.now()): JobOwner {
  return { pid: process.pid, token: processToken, host: processHost, heartbeatAt: now };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A running job is reaped only when its owner is provably gone or its lease
 * has expired. A fresh heartbeat from a live pid on this machine is kept.
 */
export function jobShouldStop(owner: JobOwner | undefined, now = Date.now()): boolean {
  if (!owner) return true;
  if (owner.token === processToken && owner.pid === process.pid) return false;
  if (now - owner.heartbeatAt > leaseMs()) return true;
  if (owner.host === processHost && !pidAlive(owner.pid)) return true;
  return false;
}

export function requestScope(): RequestScope | undefined {
  return scopeStore.getStore();
}

export function currentMcpServer(fallback: McpServer): McpServer {
  return serverStore.getStore() ?? fallback;
}

export function runRequest<T>(scope: RequestScope, mcp: McpServer, fn: () => Promise<T>): Promise<T> {
  return scopeStore.run(scope, () => serverStore.run(mcp, fn));
}

export function transportKind(): "stdio" | "http" {
  return scopeStore.getStore()?.kind ?? "stdio";
}

/** HTTP clients must not see the operator identity that stdio includes in `auth`. */
export function toolAuth(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (transportKind() === "http") return undefined;
  return source;
}

export function httpAllowsGrokSession(): boolean {
  const flag = process.env.THESHOW_HTTP_ALLOW_GROK_SESSION?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Compare a bearer token without leaking its length through an early return
 * before the digest compare. Both sides are hashed to a fixed 32 bytes first.
 */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  const presented = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(token).digest();
  const same = timingSafeEqual(left, right);
  return authorization?.startsWith(prefix) === true && presented.length > 0 && same;
}

export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export function trackWrite(work: Promise<void>): void {
  pendingWrites.add(work);
  void work.finally(() => pendingWrites.delete(work));
}

export async function flushJobWrites(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

export function startJobHeartbeat(beat: () => void): () => void {
  const timer = setInterval(beat, heartbeatMs());
  timer.unref();
  return () => clearInterval(timer);
}

export function installShutdown(drain: () => Promise<void>): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void drain().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function renderKey(kind: string, material: unknown): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

/**
 * On HTTP, a second identical in-flight render shares the first call, and a
 * successful result is reused for a few minutes. Stdio always runs the call.
 */
export function memoHttpRender<T>(
  kind: string,
  material: unknown,
  run: () => Promise<T>,
  succeeded: (value: T) => boolean,
): Promise<T> {
  if (transportKind() !== "http" || renderBypass.getStore()) return run();
  const key = renderKey(kind, material);
  const done = renderDone.get(key);
  if (done && Date.now() - done.at < RENDER_MEMORY_MS) return Promise.resolve(done.value as T);
  const pending = renderInflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = renderBypass.run(true, run).then((value) => {
    if (succeeded(value)) renderDone.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => {
    renderInflight.delete(key);
  });
  renderInflight.set(key, promise);
  return promise;
}

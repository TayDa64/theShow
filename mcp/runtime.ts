/**
 * Process identity, request scope, and small helpers shared by stdio and HTTP.
 *
 * Nothing here imports the MCP HTTP transport. The stdio bundle can use this
 * module without pulling that stack in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
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
const RENDER_MEMORY_MAX = 64;

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
  } catch (err) {
    // Another OS user owns the process. kill(pid, 0) cannot see it, but it is alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A running job is reaped only when its owner is provably gone or its lease
 * has expired. A fresh heartbeat from a live pid on this machine is kept.
 * A stamp more than five seconds ahead is expired only when that owner is on
 * this host. An owner on another host may be a minute ahead by clock skew
 * before the stamp is treated as bogus.
 */
export function jobShouldStop(owner: JobOwner | undefined, now = Date.now()): boolean {
  if (!owner) return true;
  if (owner.token === processToken && owner.pid === process.pid) return false;
  const lease = leaseMs();
  // A heartbeat dated in the future never ages out if we trust it. On this machine,
  // more than five seconds ahead is treated as expired. Another host may be that
  // far ahead by clock skew, so cross-host stamps get a minute of slack before
  // they are treated as bogus. A small skew is clamped to now and can still expire.
  const futureSlack = owner.host === processHost ? 5_000 : 60_000;
  if (owner.heartbeatAt > now + futureSlack) return true;
  const beat = Math.min(owner.heartbeatAt, now);
  if (now - beat > lease) return true;
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

/**
 * Test seam. Production leaves this unset. A probe can wait until the process
 * is killed, which is how a crash mid-write is exercised.
 */
let beforeRename: (() => Promise<void>) | undefined;

export function setBeforeRenameProbe(next: (() => Promise<void>) | undefined): void {
  beforeRename = next;
}

const TEMP_SAFE_AGE_MS = 15 * 60 * 1000;

function hostSlug(): string {
  return processHost.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 32) || "host";
}

/**
 * Delete a temp file only when this machine's writer is gone, or when the file
 * is old enough that no live writer can still own it. A young file from another
 * host is left alone.
 */
export async function sweepOrphanTemps(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const ours = hostSlug();
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const full = join(dir, name);
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - (await stat(full)).mtimeMs;
    } catch {
      continue;
    }
    if (age >= TEMP_SAFE_AGE_MS) {
      await unlink(full).catch(() => undefined);
      continue;
    }
    const match = name.match(/\.(\d+)\.([A-Za-z0-9_]+)\.[0-9a-f-]+\.tmp$/i);
    if (!match) continue;
    const pid = Number(match[1]);
    const host = match[2];
    if (host !== ours) continue;
    if (pid === process.pid || pidAlive(pid)) continue;
    await unlink(full).catch(() => undefined);
  }
}

export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await sweepOrphanTemps(dirname(path));
  const tmp = `${path}.${process.pid}.${hostSlug()}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, "utf8");
  if (beforeRename) await beforeRename();
  await rename(tmp, path);
}

/** link() is missing on some volumes. Those errors mean "try another exclusive create", not "the slot is taken". */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL"]);

function linkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && LINK_UNSUPPORTED.has(code);
}

/** Indirection so tests can stub hard links. Production calls node:fs link. */
export const exclusiveFs = {
  link: (existing: string, hardLink: string) => link(existing, hardLink),
};

/**
 * Create `dest` only if it does not exist, and only once the bytes are complete.
 * link() of a finished temp file is the normal path. When the volume cannot
 * hard-link, fall back to an exclusive create of `dest` itself, then write and
 * fsync. Callers treat an empty or partial dest as unfinished for a short grace.
 */
export async function publishExclusive(dest: string, body: string): Promise<boolean> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, body, "utf8");
  try {
    try {
      await exclusiveFs.link(tmp, dest);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      if (!linkUnsupported(err)) throw err;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(dest, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
      return true;
    } catch (err) {
      await unlink(dest).catch(() => undefined);
      throw err;
    } finally {
      await handle.close();
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Put `source` back at `dest` only when `dest` is absent.
 * A failed link leaves `source` in place. It never replaces a newer file.
 */
export async function restoreIfAbsent(source: string, dest: string): Promise<"restored" | "occupied"> {
  try {
    await exclusiveFs.link(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "occupied";
    if (!linkUnsupported(err)) throw err;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(dest, "wx");
    } catch (openErr) {
      if ((openErr as NodeJS.ErrnoException).code === "EEXIST") return "occupied";
      throw openErr;
    }
    try {
      await handle.writeFile(await readFile(source));
      await handle.sync();
    } catch (writeErr) {
      await unlink(dest).catch(() => undefined);
      throw writeErr;
    } finally {
      await handle.close();
    }
  }
  await unlink(source).catch(() => undefined);
  return "restored";
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

function rememberRender(key: string, value: unknown): void {
  renderDone.delete(key);
  renderDone.set(key, { at: Date.now(), value });
  while (renderDone.size > RENDER_MEMORY_MAX) {
    const oldest = renderDone.keys().next().value;
    if (oldest === undefined) break;
    renderDone.delete(oldest);
  }
}

function cachedRender<T>(key: string): T | undefined {
  const done = renderDone.get(key);
  if (!done) return undefined;
  if (Date.now() - done.at >= RENDER_MEMORY_MS) {
    renderDone.delete(key);
    return undefined;
  }
  renderDone.delete(key);
  renderDone.set(key, done);
  if (!done.value || typeof done.value !== "object") return done.value as T;
  return { ...(done.value as object), costUsd: 0, reused: true } as T;
}

/** retry_shot must call the generator again. The memo would hand back the failed take. */
export function withoutHttpRenderMemo<T>(fn: () => Promise<T>): Promise<T> {
  return renderBypass.run(true, fn);
}

/**
 * On HTTP, a second identical in-flight render shares the first call, and a
 * successful result is reused for a few minutes. A reused result reports no
 * extra charge. Stdio always runs the call.
 */
export function memoHttpRender<T>(
  kind: string,
  material: unknown,
  run: () => Promise<T>,
  succeeded: (value: T) => boolean,
): Promise<T> {
  if (transportKind() !== "http" || renderBypass.getStore()) return run();
  const key = renderKey(kind, material);
  const cached = cachedRender<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = renderInflight.get(key);
  if (pending) {
    return pending.then((value) => {
      if (!value || typeof value !== "object") return value as T;
      return { ...(value as object), costUsd: 0, reused: true } as T;
    });
  }
  const promise = renderBypass.run(true, run).then((value) => {
    if (succeeded(value)) rememberRender(key, value);
    return value;
  }).finally(() => {
    renderInflight.delete(key);
  });
  renderInflight.set(key, promise);
  return promise;
}

/**
 * Streamable HTTP entry for the same tools the desktop server registers.
 *
 * Built as its own bundle. The stdio bundle does not import this file.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createTheShowServer, loadCharactersFromDisk, loadJobsFromDisk, startOwnedJobHeartbeat } from "./server.ts";
import {
  bearerMatches,
  flushJobWrites,
  installShutdown,
  isLoopbackHost,
  maxSessions,
  runRequest,
  sessionTtlMs,
} from "./runtime.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY = 4 * 1024 * 1024;

type HttpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closing: boolean;
  lastActive: number;
  open: number;
  sseConnected: boolean;
};

function requireHttpToken(): string {
  const token = process.env.THESHOW_HTTP_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error(
      "THESHOW_HTTP_TOKEN is required when THESHOW_TRANSPORT=http. " +
        "Refusing to start an HTTP server without a bearer token.",
    );
  }
  return token;
}

function httpBind(): { host: string; port: number } {
  const host = process.env.THESHOW_HTTP_HOST?.trim() || DEFAULT_HOST;
  const raw = process.env.THESHOW_HTTP_PORT?.trim() || String(DEFAULT_PORT);
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `THESHOW_HTTP_PORT must be an integer from 0 to 65535 (got ${JSON.stringify(process.env.THESHOW_HTTP_PORT)}).`,
    );
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new Error(`THESHOW_HTTP_PORT must be an integer from 0 to 65535 (got ${port}).`);
  }
  if (!isLoopbackHost(host)) {
    const expose = process.env.THESHOW_HTTP_EXPOSE?.trim().toLowerCase();
    if (expose !== "1" && expose !== "true" && expose !== "yes") {
      throw new Error(
        `Refusing to bind ${host}. The default is 127.0.0.1. ` +
          "Set THESHOW_HTTP_EXPOSE=1 to listen on a non-loopback address, and put TLS in front of it.",
      );
    }
  }
  return { host, port };
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readHttpBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const fail = (err: Error) => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        fail(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => fail(err);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function messageInitializes(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((entry) => isInitializeRequest(entry));
  return isInitializeRequest(body);
}

function allowedNames(boundHost: string, boundPort: number): { hosts: string[]; origins: string[] } {
  const hosts = new Set<string>([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ]);
  if (!isLoopbackHost(boundHost)) hosts.add(`${formatHost(boundHost)}:${boundPort}`);
  for (const item of (process.env.THESHOW_HTTP_ALLOWED_HOSTS ?? "").split(",")) {
    const trimmed = item.trim();
    if (trimmed) hosts.add(trimmed);
  }
  const origins = new Set<string>([
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
  ]);
  for (const item of (process.env.THESHOW_HTTP_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = item.trim();
    if (trimmed) origins.add(trimmed);
  }
  return { hosts: [...hosts], origins: [...origins] };
}

export async function startHttpServer(): Promise<void> {
  const token = requireHttpToken();
  const { host, port } = httpBind();
  await loadJobsFromDisk();
  await loadCharactersFromDisk();
  const stopBeat = startOwnedJobHeartbeat();

  const sessions = new Map<string, HttpSession>();

  async function retire(session: HttpSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    const id = session.transport.sessionId;
    if (id) sessions.delete(id);
    try {
      await session.server.close();
    } catch (err) {
      console.error("theShow: failed to close MCP session:", err);
    }
  }

  function evictIdle(now: number): void {
    const ttl = sessionTtlMs();
    for (const session of [...sessions.values()]) {
      if (session.open === 0 && now - session.lastActive >= ttl) void retire(session);
    }
  }

  function makeRoom(): boolean {
    evictIdle(Date.now());
    if (sessions.size < maxSessions()) return true;
    const idle = [...sessions.values()]
      .filter((session) => session.open === 0)
      .sort((a, b) => a.lastActive - b.lastActive);
    const oldest = idle[0];
    if (!oldest) return false;
    void retire(oldest);
    return sessions.size < maxSessions() || oldest.closing;
  }

  const sweep = setInterval(() => evictIdle(Date.now()), Math.min(sessionTtlMs(), 5_000));
  sweep.unref();

  let allowHosts: string[] = [];
  let allowOrigins: string[] = [];

  async function openSession(): Promise<HttpSession | undefined> {
    if (!makeRoom()) return undefined;
    const session: HttpSession = {
      server: createTheShowServer(),
      transport: undefined as unknown as StreamableHTTPServerTransport,
      closing: false,
      lastActive: Date.now(),
      open: 0,
      sseConnected: false,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: allowHosts,
      allowedOrigins: allowOrigins,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
      onsessionclosed: () => retire(session),
    });
    session.transport = transport;
    transport.onclose = () => {
      if (!session.closing) void retire(session);
    };
    transport.onerror = (error) => {
      console.error("theShow HTTP session error:", error);
    };
    await session.server.connect(transport);
    return session;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      writeJson(res, 404, rpcError(-32001, "Not found. The MCP endpoint is /mcp."));
      req.resume();
      return;
    }
    if (!bearerMatches(singleHeader(req, "authorization"), token)) {
      writeJson(res, 401, rpcError(-32000, "Unauthorized"), { "WWW-Authenticate": "Bearer" });
      req.resume();
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      writeJson(res, 405, rpcError(-32000, "Method not allowed."), { Allow: "GET, POST, DELETE" });
      req.resume();
      return;
    }

    let parsedBody: unknown;
    if (req.method === "POST") {
      let raw: Buffer;
      try {
        raw = await readHttpBody(req, MAX_BODY);
      } catch (err) {
        if ((err as { code?: string }).code === "TOO_LARGE") {
          writeJson(res, 413, rpcError(-32000, "Request body too large"));
          return;
        }
        throw err;
      }
      try {
        parsedBody = JSON.parse(raw.toString("utf8"));
      } catch {
        writeJson(res, 400, rpcError(-32700, "Parse error: Invalid JSON"));
        return;
      }
    }

    const sessionId = singleHeader(req, "mcp-session-id");
    let session: HttpSession | undefined;
    if (!sessionId && req.method === "POST" && messageInitializes(parsedBody)) {
      session = await openSession();
      if (!session) {
        writeJson(res, 503, rpcError(-32000, "Too many MCP sessions."));
        return;
      }
    } else if (!sessionId) {
      writeJson(res, 400, rpcError(-32000, "Bad Request: No valid session ID provided"));
      return;
    } else {
      evictIdle(Date.now());
      session = sessions.get(sessionId);
      if (!session) {
        writeJson(res, 404, rpcError(-32001, "Session not found"));
        return;
      }
    }

    session.lastActive = Date.now();
    session.open += 1;
    if (req.method === "GET") session.sseConnected = true;
    const sseConnected = session.sseConnected;

    try {
      await runRequest(
        { kind: "http", sseConnected },
        session.server,
        () => session.transport.handleRequest(req, res, req.method === "POST" ? parsedBody : undefined),
      );
    } finally {
      session.open = Math.max(0, session.open - 1);
      session.lastActive = Date.now();
      if (req.method === "GET") session.sseConnected = false;
      const id = session.transport.sessionId;
      if (req.method === "POST" && messageInitializes(parsedBody) && (!id || !sessions.has(id))) {
        await retire(session);
      }
    }
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch((err) => {
      console.error("theShow: HTTP request failed:", err);
      writeJson(res, 500, rpcError(-32603, "Internal server error"));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    httpServer.once("error", onListenError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onListenError);
      const bound = httpServer.address();
      const boundPort = typeof bound === "object" && bound ? bound.port : port;
      const names = allowedNames(host, boundPort);
      allowHosts = names.hosts;
      allowOrigins = names.origins;
      console.error(`theShow MCP server running on http://${formatHost(host)}:${boundPort}/mcp`);
      resolve();
    });
  });

  installShutdown(async () => {
    stopBeat();
    clearInterval(sweep);
    httpServer.close();
    await flushJobWrites();
    for (const session of [...sessions.values()]) await retire(session);
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startHttpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

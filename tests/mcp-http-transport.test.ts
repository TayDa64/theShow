/**
 * Streamable HTTP transport for the same MCP server the desktop plugin runs
 * over stdio.
 *
 * The client speaks initialize and tools/list, checks the 13 input schemas
 * against tests/fixtures/mcp-tool-input-schemas.json, and never confirms a
 * render. Rejected requests are probed with create_character, which would
 * write a folder if the tool actually ran.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const LAUNCH = path.join(ROOT, "mcp", "launch.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "mcp-tool-input-schemas.json");
const TOKEN = "test-token-not-a-secret";
const PROTOCOL = "2025-11-25";

const TOOL_NAMES = [
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
] as const;

type LaunchMode = "bundle" | "source";

type ListedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type JsonRpc = {
  jsonrpc?: string;
  id?: number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

const ACCEPT = "application/json, text/event-stream";

function launchEnv(mode: LaunchMode, home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_TRANSPORT: "http",
    THESHOW_HTTP_HOST: "127.0.0.1",
    THESHOW_HTTP_PORT: "0",
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    GROK_AUTH_FILE: path.join(home, "no-auth.json"),
    ...extra,
  };
  switch (mode) {
    case "bundle":
      break;
    case "source":
      env.THESHOW_MCP_FROM_SOURCE = "1";
      break;
    default: {
      const unexpected: never = mode;
      throw new Error(`Unexpected launch mode ${unexpected}`);
    }
  }
  return env;
}

class HttpServerProcess {
  readonly child: ChildProcess;
  private stderr = "";
  private readonly ready: Promise<string>;

  constructor(mode: LaunchMode, home: string, extra: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: launchEnv(mode, home, extra),
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for HTTP server.\nSTDERR:\n${this.stderr}`));
      }, 20_000);
      this.child.stderr?.on("data", (chunk: Buffer) => {
        this.stderr += chunk.toString();
        const match = this.stderr.match(/theShow MCP server running on (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      this.child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP server exited early (${code}).\nSTDERR:\n${this.stderr}`));
      });
    });
  }

  logs(): string {
    return this.stderr;
  }

  async endpoint(): Promise<string> {
    return this.ready;
  }

  stop(): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }
}

async function characterNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function postJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; sessionId: string | null; json: JsonRpc | null; text: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: ACCEPT,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: JsonRpc | null = null;
  if (text) {
    json = JSON.parse(text) as JsonRpc;
  }
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    json,
    text,
  };
}

function initializeBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "theshow-http-test", version: "0.0.0" },
    },
  };
}

function createCharacterBody() {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "create_character", arguments: { name: "Should Not Exist" } },
  };
}

describe("streamable HTTP transport", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: ListedTool[] };

  it.each(["bundle", "source"] as const)(
    "refuses to listen when THESHOW_HTTP_TOKEN is missing (%s)",
    async (mode) => {
      const home = await mkdtemp(path.join(tmpdir(), "theshow-http-"));
      await writeFile(path.join(home, "no-auth.json"), "{}\n");
      const child = spawn(process.execPath, [LAUNCH], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: launchEnv(mode, home),
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`process still running without a token.\nSTDERR:\n${stderr}`));
          }, 15_000);
          child.on("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });
        expect(code).not.toBe(0);
        expect(stderr).toContain("THESHOW_HTTP_TOKEN");
        expect(stderr).not.toContain("running on http");
      } finally {
        const pid = child.pid;
        if (pid) {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.each(["bundle", "source"] as const)(
    "discovers the same 13 tools and isolates sessions (%s)",
    async (mode) => {
      const home = await mkdtemp(path.join(tmpdir(), "theshow-http-"));
      await writeFile(path.join(home, "no-auth.json"), "{}\n");
      const characters = path.join(home, "characters");
      const server = new HttpServerProcess(mode, home, { THESHOW_HTTP_TOKEN: TOKEN });
      try {
        const endpoint = await server.endpoint();
        expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(server.logs()).not.toContain("running on stdio");

        const missing = await postJson(endpoint, initializeBody(), {});
        expect(missing.status).toBe(401);
        expect(missing.sessionId).toBeNull();
        expect(missing.json?.error?.message).toMatch(/unauthorized/i);
        expect(missing.json?.result).toBeUndefined();

        const wrong = await postJson(endpoint, createCharacterBody(), {
          Authorization: "Bearer wrong-token",
        });
        expect(wrong.status).toBe(401);
        expect(wrong.json?.result).toBeUndefined();
        expect(await characterNames(characters)).toEqual([]);

        const basic = await postJson(endpoint, initializeBody(), {
          Authorization: "Basic dGVzdDp0ZXN0",
        });
        expect(basic.status).toBe(401);

        const initialized = await postJson(endpoint, initializeBody(), {
          Authorization: `Bearer ${TOKEN}`,
        });
        expect(initialized.status).toBe(200);
        expect(initialized.sessionId).toBeTruthy();
        const sessionId = initialized.sessionId ?? "";
        const initResult = initialized.json?.result as { protocolVersion?: string } | undefined;
        expect(initResult?.protocolVersion).toBe(PROTOCOL);

        const authed = {
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": sessionId,
          "MCP-Protocol-Version": PROTOCOL,
        };

        await postJson(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, authed);

        const listed = await postJson(endpoint, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, authed);
        expect(listed.status).toBe(200);
        const tools = (listed.json?.result as { tools?: ListedTool[] } | undefined)?.tools ?? [];
        expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
        expect(tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))).toEqual(fixture.tools);

        const unknown = await postJson(endpoint, createCharacterBody(), {
          ...authed,
          "Mcp-Session-Id": "00000000-0000-4000-8000-000000000000",
        });
        expect(unknown.status).toBe(404);
        expect(unknown.json?.result).toBeUndefined();
        expect(await characterNames(characters)).toEqual([]);

        const badVersion = await postJson(endpoint, createCharacterBody(), {
          ...authed,
          "MCP-Protocol-Version": "1999-01-01",
        });
        expect(badVersion.status).toBe(400);
        expect(badVersion.text).toMatch(/protocol version/i);
        expect(badVersion.json?.result).toBeUndefined();
        expect(await characterNames(characters)).toEqual([]);

        const removed = await fetch(endpoint, { method: "DELETE", headers: authed });
        expect(removed.status).toBe(200);

        const afterDelete = await postJson(
          endpoint,
          { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
          authed,
        );
        expect(afterDelete.status).toBe(404);
        expect(afterDelete.json?.result).toBeUndefined();

        const deletedAgain = await fetch(endpoint, { method: "DELETE", headers: authed });
        expect(deletedAgain.status).toBe(404);
      } finally {
        server.stop();
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("keeps a finished film after the MCP session is deleted", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "theshow-http-"));
    await writeFile(path.join(home, "no-auth.json"), "{}\n");
    const jobs = path.join(home, "jobs");
    await mkdir(jobs, { recursive: true });
    const jobId = "seq_http_persist";
    const jobFile = path.join(jobs, `${jobId}.json`);
    const job = {
      id: jobId,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 0,
      spentUsd: 0,
      shots: [{ index: 0, title: "Kept", status: "completed" }],
    };
    await writeFile(jobFile, `${JSON.stringify(job, null, 2)}\n`);
    const before = readFileSync(jobFile, "utf8");

    const server = new HttpServerProcess("source", home, { THESHOW_HTTP_TOKEN: TOKEN });
    try {
      const endpoint = await server.endpoint();
      const headersFor = async () => {
        const initialized = await postJson(endpoint, initializeBody(), {
          Authorization: `Bearer ${TOKEN}`,
        });
        expect(initialized.status).toBe(200);
        const sessionId = initialized.sessionId ?? "";
        expect(sessionId).not.toBe("");
        return {
          Authorization: `Bearer ${TOKEN}`,
          "Mcp-Session-Id": sessionId,
          "MCP-Protocol-Version": PROTOCOL,
        };
      };

      const first = await headersFor();
      await postJson(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, first);
      const listed = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_films", arguments: {} },
      }, first);
      expect(listed.status).toBe(200);
      const text = ((listed.json?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? "";
      expect(text).toContain(jobId);

      const removed = await fetch(endpoint, { method: "DELETE", headers: first });
      expect(removed.status).toBe(200);
      expect(readFileSync(jobFile, "utf8")).toBe(before);

      const second = await headersFor();
      await postJson(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, second);
      const again = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "list_films", arguments: {} },
      }, second);
      expect(again.status).toBe(200);
      const againText = ((again.json?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text) ?? "";
      expect(againText).toContain(jobId);
      expect(readFileSync(jobFile, "utf8")).toBe(before);
    } finally {
      server.stop();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

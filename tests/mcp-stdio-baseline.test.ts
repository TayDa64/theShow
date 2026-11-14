/**
 * Baseline for the desktop stdio server, captured before the server factory
 * was split out of transport startup.
 *
 * It starts the plugin the same way .mcp.json does (`node mcp/launch.mjs`),
 * speaks MCP initialize and tools/list, and checks every tool's input schema
 * against tests/fixtures/mcp-tool-input-schemas.json. That fixture is the
 * tools/list payload from the pre-refactor bundle. A renamed tool, a changed
 * description, or a drifted Zod input schema fails this test.
 *
 * The client never sends tools/call, so the run cannot start a paid render.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const LAUNCH = path.join(ROOT, "mcp", "launch.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "mcp-tool-input-schemas.json");

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

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
};

type ListedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

function launchEnv(mode: LaunchMode, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    GROK_AUTH_FILE: path.join(home, "no-auth.json"),
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

class StdioMcpClient {
  private readonly child: ChildProcess;
  private readonly sentMethods: string[] = [];
  private buffer = Buffer.alloc(0);
  private readonly inbox: JsonRpcMessage[] = [];
  private readonly waiters: Array<(message: JsonRpcMessage) => void> = [];
  private stderr = "";
  private nextId = 0;

  constructor(mode: LaunchMode, home: string) {
    this.child = spawn(process.execPath, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: launchEnv(mode, home),
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const index = this.buffer.indexOf(0x0a);
        if (index === -1) break;
        const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
        this.buffer = this.buffer.subarray(index + 1);
        if (!line.trim()) continue;
        this.deliver(JSON.parse(line) as JsonRpcMessage);
      }
    });
  }

  methodsSent(): readonly string[] {
    return this.sentMethods;
  }

  logs(): string {
    return this.stderr;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    this.sentMethods.push(method);
    this.send({ jsonrpc: "2.0", id, method, params });
    const message = await this.waitFor((candidate) => candidate.id === id);
    if (message.error) {
      throw new Error(`${method} failed: ${JSON.stringify(message.error)}\n${this.stderr}`);
    }
    return message.result;
  }

  notify(method: string, params?: unknown): void {
    this.sentMethods.push(method);
    this.send({ jsonrpc: "2.0", method, params });
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

  private send(message: JsonRpcMessage): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private deliver(message: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.inbox.push(message);
  }

  private waitFor(matches: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    const queuedIndex = this.inbox.findIndex(matches);
    if (queuedIndex !== -1) {
      const [message] = this.inbox.splice(queuedIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for MCP message.\nSTDERR:\n${this.stderr}`));
      }, 15_000);
      const onMessage = (message: JsonRpcMessage) => {
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

async function listTools(mode: LaunchMode): Promise<{ tools: ListedTool[]; stderr: string; methods: readonly string[] }> {
  const home = await mkdtemp(path.join(tmpdir(), "theshow-mcp-"));
  await writeFile(path.join(home, "no-auth.json"), "{}\n");
  const client = new StdioMcpClient(mode, home);
  try {
    await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "theshow-stdio-baseline", version: "0.0.0" },
    });
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {}) as { tools?: ListedTool[] };
    return {
      tools: listed.tools ?? [],
      stderr: client.logs(),
      methods: client.methodsSent(),
    };
  } finally {
    client.stop();
    await rm(home, { recursive: true, force: true });
  }
}

describe("desktop stdio launch", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: ListedTool[] };

  it.each(["bundle", "source"] as const)(
    "discovers all 13 tools through node mcp/launch.mjs (%s)",
    async (mode) => {
      const { tools, stderr, methods } = await listTools(mode);

      expect(methods).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(methods).not.toContain("tools/call");
      expect(stderr).toContain("theShow MCP server running on stdio");

      expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      expect(fixture.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);

      const actual = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      expect(actual).toEqual(fixture.tools);
    },
    20_000,
  );
});

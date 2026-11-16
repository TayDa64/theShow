/**
 * The shipped stdio bundle must ignore THESHOW_STUB_VIDEO.
 * Vitest sets VITEST for this process, so the child is given a clean env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const LAUNCH = path.join(ROOT, "mcp", "launch.mjs");

type JsonRpcMessage = {
  id?: number;
  method?: string;
  result?: { content?: Array<{ text?: string }> };
  error?: unknown;
};

function startBundle(home: string): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    THESHOW_JOBS_DIR: path.join(home, "jobs"),
    THESHOW_OUTPUT_DIR: path.join(home, "media"),
    THESHOW_CHARACTERS_DIR: path.join(home, "characters"),
    GROK_AUTH_FILE: path.join(home, "no-auth.json"),
    THESHOW_FORBID_HOME_AUTH: "1",
    THESHOW_STUB_VIDEO: "1",
  };
  delete env.VITEST;
  delete env.NODE_ENV;
  delete env.XAI_API_KEY;
  return spawn(process.execPath, [LAUNCH], {
    cwd: ROOT,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

describe("shipped bundle stub seam", () => {
  it("does not let THESHOW_STUB_VIDEO skip the session check", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "theshow-stub-bundle-"));
    await writeFile(path.join(home, "no-auth.json"), "{}\n");
    const child = startBundle(home);
    let stderr = "";
    let buffer = Buffer.alloc(0);
    const inbox: JsonRpcMessage[] = [];
    const waiters: Array<(message: JsonRpcMessage) => void> = [];
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const index = buffer.indexOf(0x0a);
        if (index === -1) break;
        const line = buffer.toString("utf8", 0, index).replace(/\r$/, "");
        buffer = buffer.subarray(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpcMessage;
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else inbox.push(message);
      }
    });
    const waitFor = (id: number) => new Promise<JsonRpcMessage>((resolve, reject) => {
      const queued = inbox.findIndex((message) => message.id === id);
      if (queued !== -1) {
        resolve(inbox.splice(queued, 1)[0]);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timed out\n${stderr}`)), 15_000);
      const onMessage = (message: JsonRpcMessage) => {
        if (message.id !== id) {
          inbox.push(message);
          waiters.push(onMessage);
          return;
        }
        clearTimeout(timer);
        resolve(message);
      };
      waiters.push(onMessage);
    });
    let nextId = 0;
    const request = async (method: string, params: unknown) => {
      const id = ++nextId;
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const message = await waitFor(id);
      if (message.error) throw new Error(JSON.stringify(message.error));
      return message.result;
    };
    try {
      await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stub-bundle", version: "0.0.0" },
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const result = await request("tools/call", {
        name: "render_sequence",
        arguments: {
          shots: [{ prompt: "A lantern.", durationSeconds: 8, title: "Walk" }],
          confirm: true,
          overrideValidation: true,
          assemble: false,
        },
      });
      const text = result?.content?.[0]?.text ?? "";
      const body = JSON.parse(text) as { jobId?: string; action?: string; error?: string; code?: string };
      expect(body.jobId).toBeUndefined();
      expect(body.action).not.toBe("started");
      expect(`${body.error ?? ""} ${body.code ?? ""}`).toMatch(/credential|session/i);
      expect(text).not.toMatch(/"error": "stub"/);
    } finally {
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      }
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});

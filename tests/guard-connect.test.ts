/**
 * E8, E9 and E10 call http/net in the forms Node forwards to Socket.connect
 * as [options, callback]. The guard must log the host and throw before the
 * socket is opened. These spawns do not query DNS or open a connection.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertGuardLog } from "./guard-log.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GUARD = path.join(ROOT, "tests", "provider-net-guard.mjs");
const CHILD = path.join(ROOT, "tests", "guard-connect-child.mjs");

async function attempt(mode: string): Promise<{ text: string; output: string; pid: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "theshow-guard-connect-"));
  const log = path.join(dir, "net-guard.log");
  const child = spawn(process.execPath, [CHILD, mode], {
    env: {
      PATH: process.env.PATH,
      THESHOW_NET_GUARD_FILE: log,
      NODE_OPTIONS: `--import ${pathToFileURL(GUARD).href}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (!pid) throw new Error("missing pid");
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const text = await readFile(log, "utf8").catch(() => "");
  await rm(dir, { recursive: true, force: true });
  return { text, output, pid };
}

describe("provider net guard connect hook", () => {
  it.each([
    ["E8", "http-request", "example.com"],
    ["E9", "http-get", "api.x.ai"],
    ["E10", "net-connect", "api.x.ai"],
    ["createConnection", "net-create", "generativelanguage.googleapis.com"],
  ] as const)("kills %s before a socket exists", async (_label, mode, host) => {
    const { text, output, pid } = await attempt(mode);
    expect(output).toMatch(/provider network blocked/);
    expect(output).not.toMatch(/dns lookup is a real network call/);
    expect(text).toContain(`connect ${host}`);
    expect(() => assertGuardLog(text, [{ pid, script: "guard-connect-child.mjs" }])).toThrow(host);
  });

  it("logs and refuses a connect whose host cannot be determined", async () => {
    const { text, output, pid } = await attempt("net-port");
    expect(output).toMatch(/provider network blocked: connect <undetermined>/);
    expect(output).not.toMatch(/dns lookup is a real network call/);
    expect(text).toContain("connect <undetermined>");
    expect(() => assertGuardLog(text, [{ pid, script: "guard-connect-child.mjs" }])).toThrow(/undetermined/);
  });
});

/**
 * Cross-process rules that do not start a render or read a real credential file.
 */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCharacter, saveCharacter } from "../mcp/characters.ts";
import { resolveVideoCredential } from "../mcp/grok-auth.ts";
import {
  bearerMatches,
  jobShouldStop,
  memoHttpRender,
  pidAlive,
  processToken,
  runRequest,
  toolAuth,
  withoutHttpRenderMemo,
} from "../mcp/runtime.ts";
import { server } from "../mcp/server.ts";

const ROOT = path.join(__dirname, "..");

describe("job lease", () => {
  it("keeps a running job while its owner pid is alive and the heartbeat is fresh", () => {
    expect(jobShouldStop({
      pid: process.pid,
      token: "someone-else",
      host: hostname(),
      heartbeatAt: Date.now(),
    })).toBe(false);
  });

  it("reaps a running job when that pid is gone", () => {
    expect(jobShouldStop({
      pid: 2_000_000_000,
      token: "someone-else",
      host: hostname(),
      heartbeatAt: Date.now(),
    })).toBe(true);
  });

  it("reaps a running job when the lease has expired", () => {
    expect(jobShouldStop({
      pid: process.pid,
      token: "someone-else",
      host: hostname(),
      heartbeatAt: Date.now() - 60_000,
    })).toBe(true);
  });

  it("does not reap the job this process owns", () => {
    expect(jobShouldStop({
      pid: process.pid,
      token: processToken,
      host: hostname(),
      heartbeatAt: 0,
    })).toBe(false);
  });

  it("reaps a legacy running job that has no owner", () => {
    expect(jobShouldStop(undefined)).toBe(true);
  });

  it("reaps a heartbeat dated far in the future", () => {
    expect(jobShouldStop({
      pid: process.pid,
      token: "someone-else",
      host: hostname(),
      heartbeatAt: Date.now() + 60 * 60 * 1000,
    })).toBe(true);
  });

  it("allows a minute of clock skew for a live owner on another host", () => {
    expect(jobShouldStop({
      pid: process.pid,
      token: "someone-else",
      host: "other-host",
      heartbeatAt: Date.now() + 10_000,
    })).toBe(false);
    expect(jobShouldStop({
      pid: process.pid,
      token: "someone-else",
      host: "other-host",
      heartbeatAt: Date.now() + 120_000,
    })).toBe(true);
  });

  it("treats EPERM from kill as a live process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      expect(pidAlive(424242)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("character writes", () => {
  it("keeps both fields when two saves of the same character overlap", async () => {
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-cast-"));
    process.env.THESHOW_CHARACTERS_DIR = dir;
    try {
      await Promise.all([
        saveCharacter({ name: "Ada", role: "lead" }),
        saveCharacter({ name: "Ada", description: "tall" }),
      ]);
      const saved = await loadCharacter("Ada");
      expect(saved?.role).toBe("lead");
      expect(saved?.description).toBe("tall");
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  });
});

describe("HTTP credential boundary", () => {
  it("does not use the Grok session unless HTTP opts in", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.THESHOW_HTTP_ALLOW_GROK_SESSION;
    const result = await runRequest({ kind: "http", sseConnected: false }, server, async () => resolveVideoCredential());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("THESHOW_HTTP_ALLOW_GROK_SESSION");
    expect(result.reason).toContain("XAI_API_KEY");
  });

  it("omits the auth label on HTTP and keeps a session label without an email on stdio", async () => {
    const hidden = await runRequest({ kind: "http", sseConnected: false }, server, async () => (
      toolAuth("Grok CLI session")
    ));
    expect(hidden).toBeUndefined();
    expect(toolAuth("Grok CLI session")).toBe("Grok CLI session");
    expect(toolAuth("Grok CLI session")).not.toContain("@");
  });

  it("rejects a bearer token whose length differs", () => {
    expect(bearerMatches("Bearer short", "a-much-longer-token")).toBe(false);
    expect(bearerMatches("Bearer exact-token", "exact-token")).toBe(true);
    expect(bearerMatches(undefined, "exact-token")).toBe(false);
  });
});

describe("HTTP render memo", () => {
  it("reports a reused result at zero cost and skips the memo when asked", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { costUsd: 1.25, status: "completed" as const };
    };
    await runRequest({ kind: "http", sseConnected: false }, server, async () => {
      const first = await memoHttpRender("clip", { prompt: "same" }, run, () => true);
      const second = await memoHttpRender("clip", { prompt: "same" }, run, () => true) as { costUsd?: number; reused?: boolean };
      expect(first.costUsd).toBe(1.25);
      expect(second.costUsd).toBe(0);
      expect(second.reused).toBe(true);
      expect(calls).toBe(1);
      const again = await withoutHttpRenderMemo(() => memoHttpRender("clip", { prompt: "same" }, run, () => true));
      expect(again.costUsd).toBe(1.25);
      expect(calls).toBe(2);
    });
  });

  it("charges only the originator when two identical renders are in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const run = async () => {
      calls += 1;
      await gate;
      return { costUsd: 1.25, status: "completed" as const };
    };
    await runRequest({ kind: "http", sseConnected: false }, server, async () => {
      const first = memoHttpRender("clip", { prompt: "overlap" }, run, () => true);
      const second = memoHttpRender("clip", { prompt: "overlap" }, run, () => true);
      release();
      const origin = await first;
      const joiner = await second as { costUsd?: number; reused?: boolean };
      expect(calls).toBe(1);
      expect(origin.costUsd).toBe(1.25);
      expect((origin as { reused?: boolean }).reused).toBeUndefined();
      expect(joiner.costUsd).toBe(0);
      expect(joiner.reused).toBe(true);
    });
  });
});

describe("stdio bundle", () => {
  it("does not contain the Streamable HTTP transport", () => {
    const stdio = readFileSync(path.join(ROOT, "mcp", "server.bundle.mjs"), "utf8");
    const http = readFileSync(path.join(ROOT, "mcp", "server-http.bundle.mjs"), "utf8");
    expect(stdio).not.toContain("StreamableHTTPServerTransport");
    expect(stdio).not.toContain("node_modules/hono/");
    expect(stdio).not.toContain("Grok CLI session as ");
    expect(http).toContain("StreamableHTTPServerTransport");
    expect(http).toContain("node_modules/hono/");
    expect(http).not.toContain("Grok CLI session as ");
  });
});

/**
 * Cross-process rules that do not start a render or read a real credential file.
 */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCharacter, saveCharacter } from "../mcp/characters.ts";
import { resolveVideoCredential } from "../mcp/grok-auth.ts";
import {
  bearerMatches,
  jobShouldStop,
  processToken,
  runRequest,
  toolAuth,
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

  it("omits the auth label on HTTP and keeps it on stdio", async () => {
    const hidden = await runRequest({ kind: "http", sseConnected: false }, server, async () => (
      toolAuth("Grok CLI session as operator@example.com")
    ));
    expect(hidden).toBeUndefined();
    expect(toolAuth("Grok CLI session as operator@example.com")).toBe("Grok CLI session as operator@example.com");
  });

  it("rejects a bearer token whose length differs", () => {
    expect(bearerMatches("Bearer short", "a-much-longer-token")).toBe(false);
    expect(bearerMatches("Bearer exact-token", "exact-token")).toBe(true);
    expect(bearerMatches(undefined, "exact-token")).toBe(false);
  });
});

describe("stdio bundle", () => {
  it("does not contain the Streamable HTTP transport", () => {
    const stdio = readFileSync(path.join(ROOT, "mcp", "server.bundle.mjs"), "utf8");
    const http = readFileSync(path.join(ROOT, "mcp", "server-http.bundle.mjs"), "utf8");
    expect(stdio).not.toContain("StreamableHTTPServerTransport");
    expect(http).toContain("StreamableHTTPServerTransport");
  });
});

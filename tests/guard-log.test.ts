/**
 * The log check is what kills a provider call the tool caught and ignored.
 * E3–E7, E18 and E19 are log shapes, so this file does not contact those hosts.
 * E8–E10 run under the preload in guard-connect.test.ts and throw first.
 */
import { describe, expect, it } from "vitest";
import { connectHost, isLoopback } from "./loopback-host.mjs";
import { assertGuardLog, type GuardedProcess } from "./guard-log.ts";

const bundle: GuardedProcess = { pid: 42, script: "server.bundle.mjs" };
const httpBundle: GuardedProcess = { pid: 43, script: "server-http.bundle.mjs" };
const loaded = `guard-loaded ${bundle.pid} ${bundle.script}\n`;

describe("provider net guard hostnames", () => {
  it("accepts localhost, 127.0.0.0/8, and ::1 only as exact hosts", () => {
    expect(isLoopback("http://127.0.0.1/mcp")).toBe(true);
    expect(isLoopback("http://127.8.9.10:8787/mcp")).toBe(true);
    expect(isLoopback("http://localhost:8787")).toBe(true);
    expect(isLoopback("http://[::1]:8787/mcp")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("")).toBe(true);
    expect(isLoopback("http://localhost.example.com/")).toBe(false);
    expect(isLoopback("https://127.0.0.1.nip.io/v1")).toBe(false);
    expect(isLoopback("https://example.com/")).toBe(false);
    expect(isLoopback("https://generativelanguage.googleapis.com/v1")).toBe(false);
    expect(isLoopback("https://api.x.ai/v1/videos")).toBe(false);
  });

  it("reads the host from Node's normalized Socket.connect array", () => {
    expect(connectHost([[{ port: 443, host: "api.x.ai" }, null]])).toBe("api.x.ai");
    expect(connectHost([[{ port: 80, hostname: "example.com" }, () => undefined]])).toBe("example.com");
    expect(connectHost([[{ port: 9 }, null]])).toBe("");
    expect(connectHost([443, "api.x.ai"])).toBe("api.x.ai");
    expect(connectHost([{ host: "127.0.0.1", port: 8787 }])).toBe("127.0.0.1");
  });
});

describe("provider net guard log", () => {
  it("accepts a loaded guard whose only calls are loopback", () => {
    expect(() => assertGuardLog(`${loaded}connect 127.0.0.1\nfetch http://localhost:8787/mcp\n`, [bundle])).not.toThrow();
  });

  it("kills E3: a swallowed fetch to generativelanguage.googleapis.com", () => {
    expect(() => assertGuardLog(`${loaded}fetch https://generativelanguage.googleapis.com/v1beta/models\n`, [bundle])).toThrow(/generativelanguage\.googleapis\.com/);
  });

  it("kills E5: a swallowed https.request to example.com", () => {
    expect(() => assertGuardLog(`${loaded}https https://example.com/\n`, [bundle])).toThrow(/example\.com/);
  });

  it("kills E6: a no-op guard that never writes the loaded marker", () => {
    expect(() => assertGuardLog("fetch https://api.x.ai/v1/videos\n", [bundle])).toThrow(/not loaded/);
    expect(() => assertGuardLog("", [bundle])).toThrow(/not loaded/);
  });

  it("kills E7: a no-op guard plus an api.x.ai fetch, and a loaded guard that still called api.x.ai", () => {
    expect(() => assertGuardLog("fetch https://api.x.ai/v1/videos\n", [bundle])).toThrow(/not loaded/);
    expect(() => assertGuardLog(`${loaded}fetch https://api.x.ai/v1/videos\n`, [bundle])).toThrow(/api\.x\.ai/);
  });

  it("kills E18: a launcher marker does not cover the server bundle", () => {
    const log = "guard-loaded 10 launch.mjs\n";
    expect(() => assertGuardLog(log, [bundle])).toThrow(/server\.bundle\.mjs pid 42/);
  });

  it("kills E19: neither bundle loaded the guard, and a logged api.x.ai fetch still fails", () => {
    const launcherOnly = "guard-loaded 10 launch.mjs\n";
    expect(() => assertGuardLog(launcherOnly, [bundle, httpBundle])).toThrow(/server\.bundle\.mjs pid 42/);
    const both = `guard-loaded ${bundle.pid} ${bundle.script}\nguard-loaded ${httpBundle.pid} ${httpBundle.script}\n`;
    expect(() => assertGuardLog(`${both}fetch https://api.x.ai/v1/videos\n`, [bundle, httpBundle])).toThrow(/api\.x\.ai/);
  });

  it("rejects a connect whose host cannot be determined", () => {
    expect(() => assertGuardLog(`${loaded}connect <undetermined>\n`, [bundle])).toThrow(/undetermined/);
  });
});

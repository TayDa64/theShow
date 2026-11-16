/**
 * The log check is what kills a provider call the tool caught and ignored.
 * E3–E7 are the mutants from the R1 review. They are log shapes, so this file
 * does not contact those hosts.
 */
import { describe, expect, it } from "vitest";
import { isLoopback } from "./loopback-host.mjs";
import { assertGuardLog, GUARD_MARKER } from "./guard-log.ts";

const loaded = `${GUARD_MARKER}\n`;

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
});

describe("provider net guard log", () => {
  it("accepts a loaded guard whose only calls are loopback", () => {
    expect(() => assertGuardLog(`${loaded}connect 127.0.0.1\nfetch http://localhost:8787/mcp\n`, 1)).not.toThrow();
  });

  it("kills E3: a swallowed fetch to generativelanguage.googleapis.com", () => {
    expect(() => assertGuardLog(`${loaded}fetch https://generativelanguage.googleapis.com/v1beta/models\n`)).toThrow(/generativelanguage\.googleapis\.com/);
  });

  it("kills E5: a swallowed https.request to example.com", () => {
    expect(() => assertGuardLog(`${loaded}https https://example.com/\n`)).toThrow(/example\.com/);
  });

  it("kills E6: a no-op guard that never writes the loaded marker", () => {
    expect(() => assertGuardLog("fetch https://api.x.ai/v1/videos\n")).toThrow(/not loaded/);
    expect(() => assertGuardLog("")).toThrow(/not loaded/);
  });

  it("kills E7: a no-op guard plus an api.x.ai fetch, and a loaded guard that still called api.x.ai", () => {
    expect(() => assertGuardLog("fetch https://api.x.ai/v1/videos\n")).toThrow(/not loaded/);
    expect(() => assertGuardLog(`${loaded}fetch https://api.x.ai/v1/videos\n`)).toThrow(/api\.x\.ai/);
  });
});

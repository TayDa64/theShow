/**
 * Preload for bundle processes in tests/e2e-bundles.test.ts.
 * Records outbound HTTP and refuses anything that is not the loopback MCP transport.
 * The production server has no provider-base override, so this is the proof
 * that a tool call did not reach api.x.ai.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { appendFileSync } from "node:fs";

const logFile = process.env.THESHOW_NET_GUARD_FILE;

function isLoopback(target) {
  const text = String(target);
  return (
    text === ""
    || text === "127.0.0.1"
    || text === "localhost"
    || text === "::1"
    || text.startsWith("http://127.0.0.1")
    || text.startsWith("http://localhost")
    || text.startsWith("http://[::1]")
    || text.startsWith("https://127.0.0.1")
    || text.startsWith("https://localhost")
  );
}

function note(kind, target) {
  const line = `${kind} ${target}\n`;
  if (logFile) appendFileSync(logFile, line);
  if (!isLoopback(target)) {
    throw new Error(`provider network blocked: ${kind} ${target}`);
  }
}

function hostOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object") {
    return input.hostname || input.host || input.href || "";
  }
  return "";
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  note("fetch", url);
  return originalFetch(input, init);
};

function wrapRequest(proto, name) {
  const original = proto.request;
  proto.request = function patched(input, options, callback) {
    note(name, hostOf(input));
    return original.call(this, input, options, callback);
  };
}

wrapRequest(http, "http");
wrapRequest(https, "https");

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  let host = "";
  if (typeof first === "object" && first) host = first.host || first.hostname || "";
  else if (typeof args[1] === "string") host = args[1];
  if (host) note("connect", host);
  return originalConnect.apply(this, args);
};

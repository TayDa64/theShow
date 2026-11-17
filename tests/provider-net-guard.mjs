/**
 * Preload for bundle processes in tests/e2e-bundles.test.ts.
 * Records outbound HTTP and refuses anything that is not loopback.
 * The production server has no provider base-URL override, so this log is the
 * proof that a tool call did not reach a provider.
 *
 * A loaded line is `guard-loaded <pid> <script>`. A connect line is `connect <host>`,
 * including `connect <undetermined>` when the host cannot be read.
 * Loopback is an exact hostname: localhost, an address in 127.0.0.0/8, or ::1.
 * Prefix matches such as localhost.example.com and 127.0.0.1.nip.io are not loopback.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { connectHost, isLoopback } from "./loopback-host.mjs";

const logFile = process.env.THESHOW_NET_GUARD_FILE;
export const GUARD_MARKER = "guard-loaded";
const scriptName = basename(process.argv[1] ?? "unknown");

if (logFile) appendFileSync(logFile, `${GUARD_MARKER} ${process.pid} ${scriptName}\n`);

export { isLoopback };

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
  // Node's public helpers call this as connect([options, cb]). A bare
  // connect(port, host) or connect(path) is the other form. No host is a
  // failure, not a skip, and originalConnect is not reached.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = connectHost([first, ...args.slice(1)]).trim();
  const target = host || "<undetermined>";
  const line = `connect ${target}\n`;
  if (logFile) appendFileSync(logFile, line);
  if (!host || !isLoopback(host)) {
    throw new Error(`provider network blocked: connect ${target}`);
  }
  return originalConnect.apply(this, args);
};

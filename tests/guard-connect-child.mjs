/**
 * One guarded attempt. The preload throws before Socket.connect runs.
 * dns.lookup is replaced so a lookup would fail the test instead of querying a resolver.
 */
import dns from "node:dns";
import { get, request } from "node:http";
import { connect, createConnection } from "node:net";

const refused = new Error("dns lookup is a real network call");
dns.lookup = () => {
  throw refused;
};
dns.promises.lookup = () => Promise.reject(refused);

const mode = process.argv[2];

function report(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`blocked ${message}\n`);
  process.exit(1);
}

if (mode === "http-request") {
  const outgoing = request("http://example.com/");
  outgoing.on("error", report);
  outgoing.end();
} else if (mode === "http-get") {
  const outgoing = get("http://api.x.ai/");
  outgoing.on("error", report);
} else if (mode === "net-connect") {
  try {
    connect(443, "api.x.ai");
  } catch (error) {
    report(error);
  }
} else if (mode === "net-create") {
  try {
    createConnection(443, "generativelanguage.googleapis.com");
  } catch (error) {
    report(error);
  }
} else if (mode === "net-port") {
  try {
    connect(9);
  } catch (error) {
    report(error);
  }
} else {
  throw new Error(`unknown mode ${mode ?? ""}`);
}

setTimeout(() => process.exit(0), 500);

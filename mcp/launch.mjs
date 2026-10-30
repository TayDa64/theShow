#!/usr/bin/env node
/**
 * Zero-setup launcher for the theShow MCP server.
 *
 * `npx -y tsx mcp/server.ts` fails on a fresh clone: npx installs tsx into its
 * own cache, so the server's imports of @modelcontextprotocol/sdk and zod
 * cannot be resolved. This wrapper installs the plugin's own dependencies on
 * first run (idempotent, skipped once node_modules exists) and then starts the
 * server.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "mcp", "server.ts");

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });

// Never write install noise to stdout: MCP speaks JSON-RPC there.
const log = (msg) => process.stderr.write(`[theshow] ${msg}\n`);

if (!existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  log("first run: installing dependencies (one time, ~30s)");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const code = await run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    stdio: ["ignore", 2, 2],
  });
  if (code !== 0) {
    log("dependency install failed. Run `npm install` in the plugin folder and retry.");
    process.exit(code);
  }
}

const tsx = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const [cmd, args] = existsSync(tsx)
  ? [tsx, [server]]
  : ["npx", ["-y", "tsx", server]];

const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

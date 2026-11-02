#!/usr/bin/env node
/**
 * Launcher for the theShow MCP server.
 *
 * The server ships pre-bundled at mcp/server.bundle.mjs, so a fresh install
 * needs no npm install at runtime. An earlier version installed dependencies
 * here on first run, which took ~13s and pushed the MCP handshake past the
 * client's initialize window, so the server looked dead on arrival.
 *
 * Source checkouts that have tsx and node_modules can set
 * THESHOW_MCP_FROM_SOURCE=1 to run mcp/server.ts directly.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const fromSource =
  process.env.THESHOW_MCP_FROM_SOURCE === "1" &&
  existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"));

const args = fromSource
  ? [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "mcp", "server.ts")]
  : [join(root, "mcp", "server.bundle.mjs")];

if (!existsSync(args[args.length - 1])) {
  process.stderr.write(
    "[theshow] server bundle missing at mcp/server.bundle.mjs. " +
      "Reinstall the plugin, or run `npm install && npm run build:mcp` in the plugin folder.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

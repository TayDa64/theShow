#!/usr/bin/env node
/**
 * Launcher for the theShow MCP server.
 *
 * The server ships pre-bundled at mcp/server.bundle.mjs, so a fresh install
 * needs no npm install at runtime.
 *
 * Two things this guards against, both learned from real install failures:
 *  - Installing dependencies at launch took ~13s, which overran the client's
 *    MCP initialize window, so the server looked dead on arrival.
 *  - Clients spawn this script with the plugin's relative path resolved from
 *    the home directory, not the plugin folder, so it can be invoked as a
 *    path that does not exist. Resolve everything from this file's own
 *    location instead of trusting argv or the working directory.
 *
 * Source checkouts with node_modules can set THESHOW_MCP_FROM_SOURCE=1 to run
 * mcp/server.ts directly.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const fromSource =
  process.env.THESHOW_MCP_FROM_SOURCE === "1" &&
  existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"));

const bundle = join(here, "server.bundle.mjs");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

const [script, mode] = fromSource
  ? [tsxCli, "source"]
  : [bundle, "bundle"];

if (!existsSync(script)) {
  process.stderr.write(
    `[theshow] ${mode} entry point missing at ${script}. ` +
      "Reinstall the plugin, or run `npm install && npm run build:mcp`.\n",
  );
  process.exit(1);
}

const args = mode === "source" ? [script, join(here, "server.ts")] : [script];
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

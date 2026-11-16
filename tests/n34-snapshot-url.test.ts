/**
 * N34 kills P39: snapshotCharacter must not read a remote URL as a file.
 * `readFile("https://example.test/remy.png")` resolves that string as the
 * relative path `https:/example.test/remy.png`.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "tests/n34-snapshot-url-child.ts");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("snapshotCharacter skips remote URLs", () => {
  it("leaves references empty when the URL string is also a real relative file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "theshow-n34-"));
    const trap = path.join(cwd, "https:", "example.test", "remy.png");
    await mkdir(path.dirname(trap), { recursive: true });
    await writeFile(trap, PNG);
    const characters = path.join(cwd, "characters");
    await mkdir(characters, { recursive: true });
    const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, CHILD], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        THESHOW_CHARACTERS_DIR: characters,
        GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
        THESHOW_FORBID_HOME_AUTH: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`n34 child timed out\n${stderr}`));
      }, 30_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    try {
      expect(code, stderr).toBe(0);
      const body = JSON.parse(stdout) as {
        stored: string[];
        references: Array<{ path: string; sha256: string }> | null;
      };
      expect(body.stored).toEqual(["https://example.test/remy.png"]);
      expect(body.references).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 40_000);
});

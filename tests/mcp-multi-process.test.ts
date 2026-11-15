/**
 * Cross-process checks for character locks and film claims.
 * Children do not render and do not read a credential file.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCharacter, saveCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "tests/mcp-multi-child.ts");

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    GROK_AUTH_FILE: "/nonexistent/theshow-test-auth.json",
    THESHOW_FORBID_HOME_AUTH: "1",
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], {
      cwd: ROOT,
      env,
    });
    const stdoutChunks: string[] = [];
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: stdoutChunks.join(""), stderr }));
  });
}

/** Spawn claimers and keep each one alive until every one has answered. */
function claimTogether(id: string, count: number, env: NodeJS.ProcessEnv): Promise<Array<{ status: number | null; stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const children = Array.from({ length: count }, () => spawn(process.execPath, ["--import", "tsx", CHILD, "claim", id], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const results = children.map(() => ({ status: null as number | null, stdout: "", stderr: "", done: false }));
    let answered = 0;
    let settled = 0;
    const finish = () => {
      if (settled === children.length) resolve(results);
    };
    children.forEach((child, index) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        results[index].stdout += chunk;
        if (!results[index].done && results[index].stdout.includes("\n")) {
          results[index].done = true;
          answered += 1;
          if (answered === children.length) {
            for (const held of children) held.stdin.end();
          }
        }
      });
      child.stderr.on("data", (chunk: string) => {
        results[index].stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        results[index].status = status;
        settled += 1;
        finish();
      });
    });
  });
}

describe("multi-process character saves", () => {
  it("keeps every field when three processes save one character together", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-cast-mp-"));
    const env = childEnv({ THESHOW_CHARACTERS_DIR: dir });
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    process.env.THESHOW_CHARACTERS_DIR = dir;
    try {
      for (let round = 0; round < 30; round++) {
        const name = `Ada ${round}`;
        await saveCharacter({ name });
        const results = await Promise.all([
          runChild(["save", name, "role", "lead"], env),
          runChild(["save", name, "description", "tall"], env),
          runChild(["save", name, "appearance", "dark hair"], env),
        ]);
        const failures = results.filter((result) => result.status !== 0);
        expect(failures, failures.map((result) => result.stderr).join("\n")).toEqual([]);
        const saved = await loadCharacter(name);
        expect(saved, `round ${round}`).toMatchObject({
          role: "lead",
          description: "tall",
          appearance: "dark hair",
        });
      }
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  }, 180_000);
});

describe("multi-process stale character locks", () => {
  it("keeps every field when five saves recover a crashed lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-cast-stale-"));
    const env = childEnv({ THESHOW_CHARACTERS_DIR: dir });
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    process.env.THESHOW_CHARACTERS_DIR = dir;
    try {
      for (let round = 0; round < 20; round++) {
        const name = `Ora ${round}`;
        const seeded = await saveCharacter({ name });
        await writeFile(path.join(seeded.folder, ".write.lock"), JSON.stringify({
          pid: 2_000_000_000,
          token: "crashed",
          host: hostname(),
          at: Date.now() - 60_000,
        }));
        const results = await Promise.all([
          runChild(["save", name, "role", "lead"], env),
          runChild(["save", name, "description", "tall"], env),
          runChild(["save", name, "appearance", "dark hair"], env),
          runChild(["save", name, "role", "lead"], env),
          runChild(["save", name, "description", "tall"], env),
        ]);
        const failures = results.filter((result) => result.status !== 0);
        expect(failures, failures.map((result) => result.stderr).join("\n")).toEqual([]);
        const saved = await loadCharacter(name);
        expect(saved, `round ${round}`).toMatchObject({
          role: "lead",
          description: "tall",
          appearance: "dark hair",
        });
        const names = await readdir(seeded.folder);
        expect(names.filter((entry) => entry.includes(".steal."))).toEqual([]);
      }
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  }, 180_000);

  it("keeps every field when a dead turn file and a stale lock are both left behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-cast-turn-"));
    const env = childEnv({ THESHOW_CHARACTERS_DIR: dir });
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    process.env.THESHOW_CHARACTERS_DIR = dir;
    const past = new Date(Date.now() - 60_000);
    try {
      for (let round = 0; round < 40; round++) {
        const name = `Nia ${round}`;
        const seeded = await saveCharacter({ name });
        const lockPath = path.join(seeded.folder, ".write.lock");
        const turnPath = `${lockPath}.turn`;
        const crashed = {
          pid: 2_000_000_000,
          token: "crashed",
          host: hostname(),
          at: Date.now() - 60_000,
        };
        await writeFile(lockPath, JSON.stringify(crashed));
        await writeFile(turnPath, JSON.stringify(crashed));
        await utimes(lockPath, past, past);
        await utimes(turnPath, past, past);
        const results = await Promise.all([
          runChild(["save", name, "role", "lead"], env),
          runChild(["save", name, "description", "tall"], env),
          runChild(["save", name, "appearance", "dark hair"], env),
          runChild(["save", name, "role", "lead"], env),
          runChild(["save", name, "description", "tall"], env),
        ]);
        const failures = results.filter((result) => result.status !== 0);
        expect(failures, failures.map((result) => result.stderr).join("\n")).toEqual([]);
        const saved = await loadCharacter(name);
        expect(saved, `round ${round}`).toMatchObject({
          role: "lead",
          description: "tall",
          appearance: "dark hair",
        });
        const names = await readdir(seeded.folder);
        expect(names.filter((entry) => entry.includes(".steal.")), `round ${round} ${names.join(",")}`).toEqual([]);
      }
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  }, 180_000);
});

describe("multi-process film claims", () => {
  it("lets exactly one of eight processes take an empty claim or a dead-pid claim", async () => {
    await mkdir(JOBS_DIR, { recursive: true });
    const env = childEnv({ THESHOW_JOBS_DIR: JOBS_DIR });
    const film = (id: string) => JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 0,
      spentUsd: 0,
      shots: [{ index: 1, title: "Shot", status: "completed", localPath: "/tmp/clip.mp4" }],
    });

    for (const kind of ["empty", "dead"] as const) {
      for (let round = 0; round < 15; round++) {
        const id = `seq_mp_${kind}_${round}_${Date.now().toString(36)}`;
        await writeFile(path.join(JOBS_DIR, `${id}.json`), film(id));
        const claim = path.join(JOBS_DIR, `${id}.claim`);
        if (kind === "empty") {
          await writeFile(claim, "");
          const past = new Date(Date.now() - 5_000);
          await utimes(claim, past, past);
        } else {
          await writeFile(claim, JSON.stringify({
            pid: 2_000_000_000,
            token: "dead",
            host: hostname(),
            heartbeatAt: Date.now(),
          }));
        }
        const results = await claimTogether(id, 8, env);
        const failures = results.filter((result) => result.status !== 0);
        expect(failures, failures.map((result) => result.stderr).join("\n")).toEqual([]);
        const wins = results.filter((result) => {
          const line = result.stdout.trim().split("\n").at(-1) ?? "";
          return (JSON.parse(line) as { ok?: boolean }).ok === true;
        });
        expect(wins, `${kind} round ${round}\n${results.map((result) => result.stdout).join(" | ")}`).toHaveLength(1);
      }
    }
  }, 180_000);
});

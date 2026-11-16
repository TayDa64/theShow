/**
 * The two advisory tools through the MCP server: read-only, no provider calls,
 * and the test-only kills for the queued-spend mutants.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { saveCharacter, snapshotCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { consistencyDirectory } from "../mcp/crossFilm.ts";
import { enqueueSpendNote, readQueuedFilmSpend, server } from "../mcp/server.ts";
import { processHost } from "../mcp/runtime.ts";

const suiteRoot = path.dirname(JOBS_DIR);
process.env.THESHOW_CHARACTERS_DIR = path.join(suiteRoot, "characters");
process.env.THESHOW_CONSISTENCY_DIR = path.join(suiteRoot, "consistency");

const ORIGINAL_TOOLS = [
  "configure_film",
  "create_character",
  "plan_storyboard",
  "generate_controlled_clip",
  "extend_clip",
  "extract_last_frame",
  "generate_still",
  "assemble_film",
  "render_sequence",
  "board_film",
  "retry_shot",
  "list_films",
  "check_sequence",
  "review_continuity",
  "propose_repair",
] as const;

let client: Client;
const fetchCalls: string[] = [];
const previousFetch = globalThis.fetch;

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

function spendKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) spendKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "costQuote" || key === "confirm" || key.startsWith("approved")) found.push(key);
    spendKeys(child, found);
  }
  return found;
}

async function stamp(file: string): Promise<string> {
  const info = await stat(file, { bigint: true });
  const bytes = await readFile(file);
  return `${createHash("sha256").update(bytes).digest("hex")}:${info.mtimeNs.toString()}:${info.size.toString()}`;
}

async function freeze(file: string): Promise<string> {
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(file, old, old);
  return stamp(file);
}

beforeAll(async () => {
  await mkdir(process.env.THESHOW_CHARACTERS_DIR!, { recursive: true });
  await mkdir(process.env.THESHOW_CONSISTENCY_DIR!, { recursive: true });
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("phase 2 tool test: no provider call is allowed");
  }) as typeof fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "phase2-tools", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  globalThis.fetch = previousFetch;
  await client.close();
});

describe("phase 2 tools", () => {
  it("appends the two advisory tools after the existing fifteen", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names.slice(0, ORIGINAL_TOOLS.length)).toEqual([...ORIGINAL_TOOLS]);
    expect(names.slice(ORIGINAL_TOOLS.length)).toEqual(["suggest_coverage", "check_cross_film"]);
  });

  it("kills mutation: emitting a costQuote from a suggestion", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "suggest_coverage",
      arguments: {
        usedBuiltInLadder: false,
        beats: [
          { title: "Climax", shotType: "close-up", locationId: "hall", durationSeconds: 8 },
          { title: "Establishing", shotType: "wide", locationId: "hall", durationSeconds: 8 },
        ],
      },
    });
    const body = JSON.parse(toolText(result)) as {
      executed: boolean;
      willRender: boolean;
      willSpend: boolean;
      mutatedPaths: unknown[];
      suggestions: Array<{ kind: string; wouldSpend: boolean; shots: number[] }>;
    };
    expect(body.executed).toBe(false);
    expect(body.willRender).toBe(false);
    expect(body.willSpend).toBe(false);
    expect(body.mutatedPaths).toEqual([]);
    expect(body.suggestions.filter((item) => item.kind === "structure")).toEqual([]);
    expect(body.suggestions.map((item) => item.shots[0])).toContain(1);
    expect(body.suggestions.every((item) => item.wouldSpend === false)).toBe(true);
    expect(spendKeys(body)).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it("kills mutation: letting check_cross_film call refreshJobsFromDisk or a write path", async () => {
    fetchCalls.length = 0;
    const legacyId = "seq_phase2_legacy";
    const phaseId = "seq_phase2_phase1";
    const runningId = "seq_phase2_running";
    const legacy = {
      id: legacyId,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [{ index: 1, title: "Old", status: "completed", prompt: "close-up of a face", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: true, pin: "start", characters: ["Ada"] },
    };
    const phase = {
      ...legacy,
      id: phaseId,
      spendLedger: { version: 1, spentUsd: 1, pendingUsd: 0, appliedNoteIds: [] as string[] },
      settings: { ...legacy.settings, aspectRatio: "9:16" },
    };
    const running = {
      ...legacy,
      id: runningId,
      state: "running",
      owner: { pid: 2_147_483_646, token: "dead-token", host: processHost, heartbeatAt: Date.now() },
    };
    await writeFile(path.join(JOBS_DIR, `${legacyId}.json`), JSON.stringify(legacy, null, 2));
    await writeFile(path.join(JOBS_DIR, `${phaseId}.json`), JSON.stringify(phase, null, 2));
    await writeFile(path.join(JOBS_DIR, `${runningId}.json`), JSON.stringify(running, null, 2));
    await writeFile(path.join(JOBS_DIR, `${phaseId}.claim`), JSON.stringify({ pid: 1, token: "claim", host: processHost, heartbeatAt: 1 }));
    await enqueueSpendNote(phaseId, { op: "spend", kind: "video", usd: 0.25 });
    await enqueueSpendNote(phaseId, { op: "spend", kind: "video", usd: 0.4 });
    const journal = path.join(JOBS_DIR, ".spend-journal", phaseId);
    const noteFiles = (await readdir(journal)).filter((name) => name.endsWith(".json")).sort();
    expect(noteFiles).toHaveLength(2);
    const parsedNotes = await Promise.all(noteFiles.map(async (name) => (
      JSON.parse(await readFile(path.join(journal, name), "utf8")) as { id: string; usd: number }
    )));
    const appliedNote = parsedNotes.find((note) => note.usd === 0.25);
    expect(appliedNote?.id).toBeTruthy();
    const saved = JSON.parse(await readFile(path.join(JOBS_DIR, `${phaseId}.json`), "utf8")) as { spendLedger: { appliedNoteIds: string[] } };
    saved.spendLedger.appliedNoteIds = [appliedNote?.id ?? ""];
    await writeFile(path.join(JOBS_DIR, `${phaseId}.json`), JSON.stringify(saved, null, 2));
    const portrait = path.join(suiteRoot, "ada.png");
    await writeFile(portrait, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ));
    const ada = await saveCharacter({ name: "Ada", referenceImageUrls: [portrait] });
    const characterFile = path.join(ada.folder, "character.json");

    const files = [
      path.join(JOBS_DIR, `${legacyId}.json`),
      path.join(JOBS_DIR, `${phaseId}.json`),
      path.join(JOBS_DIR, `${runningId}.json`),
      path.join(JOBS_DIR, `${phaseId}.claim`),
      path.join(journal, noteFiles[0]),
      path.join(journal, noteFiles[1]),
      characterFile,
    ];
    const before = new Map<string, string>();
    for (const file of files) before.set(file, await freeze(file));

    const coverage = JSON.parse(toolText(await client.callTool({
      name: "suggest_coverage",
      arguments: { jobId: legacyId },
    }))) as { suggestions: Array<{ abstention?: string }> };
    expect(coverage.suggestions.some((item) => item.abstention === "shot type not recorded on this film")).toBe(true);
    expect(JSON.stringify(coverage)).not.toContain("close-up of a face");

    const compared = JSON.parse(toolText(await client.callTool({
      name: "check_cross_film",
      arguments: { jobIds: [legacyId, phaseId, runningId] },
    }))) as { films: Array<{ jobId: string; pendingSpendUsd: number }>; persisted: boolean };
    expect(compared.persisted).toBe(false);
    expect(compared.films.find((film) => film.jobId === phaseId)?.pendingSpendUsd).toBe(0.4);
    expect(compared.films.find((film) => film.jobId === runningId)?.pendingSpendUsd).toBe(0);

    const persisted = JSON.parse(toolText(await client.callTool({
      name: "check_cross_film",
      arguments: { jobIds: [legacyId, phaseId], persist: true },
    }))) as { persisted: boolean; reportPath?: string; reportId?: string; id?: string; mutatedPaths?: string[] };
    expect(persisted.persisted).toBe(true);
    expect(persisted.mutatedPaths).toEqual([persisted.reportPath]);
    expect(persisted.id).toBeUndefined();
    expect(persisted.reportPath?.startsWith(consistencyDirectory())).toBe(true);
    const reportFile = JSON.parse(await readFile(persisted.reportPath ?? "", "utf8")) as { id?: string; reportId?: string };
    expect(reportFile.id).toBeUndefined();
    expect(reportFile.reportId).toBe(persisted.reportId);

    for (const file of files) {
      expect(await stamp(file), file).toBe(before.get(file));
    }
    const runningRaw = JSON.parse(await readFile(path.join(JOBS_DIR, `${runningId}.json`), "utf8")) as { state: string };
    expect(runningRaw.state).toBe("running");
    const names = await readdir(JOBS_DIR);
    expect(names.filter((name) => name.endsWith(".json")).sort()).toEqual([
      `${legacyId}.json`,
      `${phaseId}.json`,
      `${runningId}.json`,
    ].sort());
    expect(names.filter((name) => name.startsWith(".review-frames-"))).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it("kills M41: a note already in appliedNoteIds is not pending", async () => {
    const id = `seq_phase2_m41_${randomUUID()}`;
    await enqueueSpendNote(id, { op: "spend", kind: "video", usd: 0.25 });
    await enqueueSpendNote(id, { op: "spend", kind: "video", usd: 0.4 });
    const dir = path.join(JOBS_DIR, ".spend-journal", id);
    const notes = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json")).sort().map(async (name) => (
      JSON.parse(await readFile(path.join(dir, name), "utf8")) as { id: string; usd: number }
    )));
    const applied = notes.find((note) => note.usd === 0.25);
    const queued = await readQueuedFilmSpend(id, [applied?.id ?? ""]);
    expect(queued.pendingSpendUsd).toBe(0.4);
    expect(queued.pendingSpendUsd).not.toBe(0.65);
  });

  it("kills M44: a queued budget warns when the caller sends no budgetUsd", async () => {
    const id = "seq_phase2_m44";
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 0,
      spentUsd: 0,
      shots: [{ index: 1, title: "Old", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    await enqueueSpendNote(id, { op: "budget", thresholdUsd: 0.1 });
    const before = await stamp(path.join(JOBS_DIR, `${id}.json`));
    const body = JSON.parse(toolText(await client.callTool({
      name: "generate_controlled_clip",
      arguments: {
        prompt: "A man walks across the courtyard.",
        jobId: id,
        confirm: false,
        durationSeconds: 8,
        resolution: "720p",
      },
    }))) as { budgetWarning?: string; action?: string };
    expect(body.action).toBe("estimate-only");
    expect(body.budgetWarning).toMatch(/0\.10/);
    expect(body.budgetWarning).toMatch(/does not authorize/);
    expect(await stamp(path.join(JOBS_DIR, `${id}.json`))).toBe(before);
  });

  it("stores shotType and a character snapshot on a new render and leaves a legacy file alone", async () => {
    const legacyId = "seq_phase2_untouched";
    const legacyPath = path.join(JOBS_DIR, `${legacyId}.json`);
    await writeFile(legacyPath, JSON.stringify({
      id: legacyId,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [{ index: 1, title: "Keep", status: "completed", prompt: "A lantern.", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    const before = await freeze(legacyPath);
    const portrait = path.join(suiteRoot, "ada-snap.png");
    await writeFile(portrait, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ));
    await saveCharacter({ name: "Ada", referenceImageUrls: [portrait] });
    process.env.THESHOW_STUB_VIDEO = "completed";
    try {
      const rendered = JSON.parse(toolText(await client.callTool({
        name: "render_sequence",
        arguments: {
          shots: [{ prompt: "A man walks across the courtyard.", durationSeconds: 4, title: "Walk", shotType: "wide" }],
          characters: ["Ada"],
          confirm: true,
          overrideValidation: true,
          assemble: false,
        },
      }))) as { jobId?: string };
      expect(rendered.jobId).toBeTruthy();
      let saved: { shots?: Array<{ shotType?: string }>; characterSnapshots?: Array<{ name: string; references: Array<{ sha256: string }> }> } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        saved = JSON.parse(await readFile(path.join(JOBS_DIR, `${rendered.jobId}.json`), "utf8"));
        if (saved?.shots?.[0]?.shotType) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(saved?.shots?.[0]?.shotType).toBe("wide");
      expect(saved?.characterSnapshots?.[0]?.name).toBe("Ada");
      expect(saved?.characterSnapshots?.[0]?.references[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await stamp(legacyPath)).toBe(before);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  });

  it("F3: a job file that fails the schema is present but not readable", async () => {
    const bad = "seq_phase2_malformed";
    const good = "seq_phase2_malformed_ok";
    await writeFile(path.join(JOBS_DIR, `${bad}.json`), JSON.stringify({
      id: bad,
      startedAt: 1,
      state: "completed",
      spentUsd: 0,
      shots: [{ index: 1 }],
      ledger: { props: [{ id: "lamp", name: "lamp" }] },
    }));
    await writeFile(path.join(JOBS_DIR, `${good}.json`), JSON.stringify({
      id: good,
      startedAt: 2,
      state: "completed",
      spentUsd: 0,
      shots: [{ index: 1, title: "Ok" }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "m", pin: "start" },
    }));
    const body = JSON.parse(toolText(await client.callTool({
      name: "check_cross_film",
      arguments: { jobIds: [bad, good] },
    }))) as { findings: Array<{ summary: string; class: string; jobIds: string[] }> };
    const finding = body.findings.find((item) => item.jobIds.includes(bad));
    expect(finding?.class).toBe("unverified");
    expect(finding?.summary).toMatch(/present but could not be parsed/);
    expect(finding?.summary).not.toMatch(/not on disk/);
    expect(finding?.summary).toMatch(/locationId/);
  });

  it("P30: persist inside the jobs directory is refused and writes nothing", async () => {
    const ids = ["seq_phase2_inside_a", "seq_phase2_inside_b"];
    for (const id of ids) {
      await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify({
        id,
        startedAt: 1,
        state: "completed",
        spentUsd: 0,
        shots: [{ index: 1, title: "Ok" }],
        settings: { aspectRatio: "16:9", resolution: "720p", model: "m", pin: "start" },
      }));
    }
    const previous = process.env.THESHOW_CONSISTENCY_DIR;
    const inside = path.join(JOBS_DIR, "consistency-inside");
    process.env.THESHOW_CONSISTENCY_DIR = inside;
    try {
      const body = JSON.parse(toolText(await client.callTool({
        name: "check_cross_film",
        arguments: { jobIds: ids, persist: true },
      }))) as { persisted: boolean; persistError?: string; mutatedPaths: string[] };
      expect(body.persisted).toBe(false);
      expect(body.persistError).toMatch(/inside the jobs directory/);
      expect(body.mutatedPaths).toEqual([]);
      const names = await readdir(JOBS_DIR);
      expect(names.filter((name) => name.startsWith("cxf_"))).toEqual([]);
      expect(names.includes("consistency-inside")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CONSISTENCY_DIR;
      else process.env.THESHOW_CONSISTENCY_DIR = previous;
    }
  });

  it("P32: a review-frame directory is removed before the tool returns", async () => {
    const clip = path.join(JOBS_DIR, "phase2-frame-source.bin");
    await writeFile(clip, "not-a-video");
    const ids = ["seq_phase2_frameclean_a", "seq_phase2_frameclean_b"];
    for (const id of ids) {
      await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify({
        id,
        startedAt: 1,
        state: "completed",
        spentUsd: 0,
        shots: [{ index: 1, title: "Ok", localPath: clip }],
        settings: { aspectRatio: "16:9", resolution: "720p", model: "m", pin: "start" },
      }));
    }
    await client.callTool({ name: "check_cross_film", arguments: { jobIds: ids } });
    const names = await readdir(JOBS_DIR);
    expect(names.filter((name) => name.startsWith(".review-frames-"))).toEqual([]);
  });

  it("P39: a remote reference URL is not hashed", async () => {
    const url = "https://example.test/remy.png";
    const folder = path.join(process.env.THESHOW_CHARACTERS_DIR!, "remy");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "character.json"), JSON.stringify({
      id: "remy",
      name: "Remy",
      referenceImageUrls: [url],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    }));
    const snap = await snapshotCharacter("Remy");
    expect(snap?.references).toEqual([]);
    const hashedUrl = createHash("sha256").update(url).digest("hex");
    expect(JSON.stringify(snap)).not.toContain(hashedUrl);
  });

  it("P40: retry_shot stores a character snapshot on the new job", async () => {
    const portrait = path.join(suiteRoot, "ada-retry.png");
    await writeFile(portrait, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ));
    await saveCharacter({ name: "Ada", referenceImageUrls: [portrait] });
    const source = "seq_phase2_retry_source";
    await writeFile(path.join(JOBS_DIR, `${source}.json`), JSON.stringify({
      id: source,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [{ index: 1, title: "Old", status: "completed", prompt: "A man walks across the courtyard.", durationSeconds: 4, localPath: "/keep/old.mp4" }],
      settings: {
        aspectRatio: "16:9",
        resolution: "720p",
        model: "grok-imagine-video-1.5",
        fadeDuration: 0,
        assemble: false,
        pin: "start",
        characters: ["Ada"],
      },
    }));
    process.env.THESHOW_STUB_VIDEO = "completed";
    try {
      const retried = JSON.parse(toolText(await client.callTool({
        name: "retry_shot",
        arguments: { jobId: source, shotIndex: 1, confirm: true, overrideValidation: true },
      }))) as { jobId?: string };
      expect(retried.jobId).toBeTruthy();
      let snap: { name?: string } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const saved = JSON.parse(await readFile(path.join(JOBS_DIR, `${retried.jobId}.json`), "utf8")) as {
          characterSnapshots?: Array<{ name: string }>;
        };
        snap = saved.characterSnapshots?.[0];
        if (snap) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(snap?.name).toBe("Ada");
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  });
});

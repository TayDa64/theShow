/**
 * Cross-film classifications on a legacy job, a Phase 1 job, a resumed film,
 * a repaired film, and a character record newer than one of the films.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCrossFilm,
  consistencyDirIsSafe,
  parseCrossFilmJob,
  type CharacterFact,
  type CrossFilmJob,
} from "../mcp/crossFilm.ts";

function job(partial: Record<string, unknown> & { id: string }): CrossFilmJob {
  const parsed = parseCrossFilmJob({
    startedAt: 1_700_000_000_000,
    state: "completed",
    spentUsd: 1.12,
    shots: [{ index: 1, title: "Old", durationSeconds: 8 }],
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      pin: "start",
      voiceId: "rex",
      clipAudio: "keep",
      characters: ["Ada"],
    },
    ...partial,
  }, `/films/${partial.id}.json`);
  if (!parsed) throw new Error(`fixture ${partial.id} did not parse`);
  return parsed;
}

const ada: CharacterFact = {
  name: "Ada",
  updatedAt: "2024-06-01T00:00:00.000Z",
  path: "/characters/ada/character.json",
};

function input(jobs: CrossFilmJob[], extra: Partial<Parameters<typeof checkCrossFilm>[0]> = {}) {
  return {
    jobs,
    characters: new Map<string, CharacterFact | undefined>([["ada", ada]]),
    pendingSpendUsd: new Map(jobs.map((entry) => [entry.id, 0])),
    intentionalWardrobeDifference: false,
    fileExists: () => false,
    filesIdentical: () => false,
    correlate: async () => undefined,
    resolveFirstFrame: async (entry: CrossFilmJob) => ({ cited: entry.path, ephemeral: false }),
    ...extra,
  };
}

describe("check_cross_film", () => {
  const legacy = job({
    id: "legacy",
    startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    settings: {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      pin: "start",
      characters: ["Ada"],
    },
  });
  const phase1 = job({
    id: "phase1",
    startedAt: Date.parse("2023-01-01T00:00:00.000Z"),
    spendLedger: { appliedNoteIds: ["note-applied"] },
    settings: {
      aspectRatio: "9:16",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      pin: "both",
      voiceId: "rex",
      clipAudio: "mute",
      characters: ["Ada"],
    },
    ledger: {
      promptStyle: "sections-v2",
      props: [{ id: "lamp", locationId: "kitchen", name: "lamp", placement: "on the table" }],
      shots: [{
        shot: 1,
        locationId: "kitchen",
        checklists: [{ character: "Ada", worn: [{ id: "coat" }] }],
      }],
    },
  });
  const resumed = job({
    id: "resumed",
    startedAt: Date.parse("2026-02-01T00:00:00.000Z"),
    resumedFrom: { jobId: "phase1", fromShot: 1 },
    ledger: {
      promptStyle: "legacy",
      props: [{ id: "lamp", locationId: "kitchen", name: "lamp", placement: "on the floor" }],
      shots: [{
        shot: 1,
        locationId: "kitchen",
        checklists: [{ character: "Ada", worn: [{ id: "shirt" }] }],
      }],
    },
  });
  const repaired = job({
    id: "repaired",
    startedAt: Date.parse("2026-03-01T00:00:00.000Z"),
    repairedFrom: { jobId: "resumed", shotIndex: 1 },
    characterSnapshots: [{
      name: "Ada",
      updatedAt: "2024-06-01T00:00:00.000Z",
      references: [{ path: "/characters/ada/now.png", sha256: "abc" }],
    }],
  });

  it("classifies drift, wardrobe, settings, props, lineage, and does not guess a face", async () => {
    const report = await checkCrossFilm(input([legacy, phase1, resumed, repaired], {
      pendingSpendUsd: new Map([["phase1", 0.4], ["legacy", 0]]),
    }));
    expect(report.version).toBe(1);
    expect(report.executed).toBe(false);
    expect(report.willSpend).toBe(false);
    expect(report.mutatedPaths).toEqual([]);
    expect(report.films.map((film) => film.pendingSpendUsd)).toEqual([0, 0.4, 0, 0]);
    expect(report.films.reduce((sum, film) => sum + film.spentUsd, 0)).toBeGreaterThan(0);
    expect("totalSpendUsd" in report).toBe(false);
    expect(JSON.stringify(report)).not.toContain("seriesBudget");

    const changed = report.findings.filter((finding) => finding.summary.includes("changed after this film"));
    expect(changed.map((finding) => finding.jobIds[0])).toEqual(["phase1"]);
    expect(changed.every((finding) => finding.class === "measured")).toBe(true);
    expect(changed.every((finding) => finding.evidence?.method === "character-updatedAt")).toBe(true);
    const unknown = report.findings.filter((finding) => finding.summary.includes("no history"));
    expect(unknown.map((finding) => finding.jobIds[0])).toEqual(["phase1"]);
    expect(unknown.every((finding) => finding.class === "unverified")).toBe(true);
    expect(report.findings.some((finding) => finding.jobIds.includes("repaired") && finding.summary.includes("not later"))).toBe(true);
    expect(report.findings.some((finding) => finding.jobIds.includes("legacy") && finding.summary.includes("not later"))).toBe(true);

    const wardrobe = report.findings.find((finding) => finding.topic === "wardrobe" && finding.class === "measured");
    expect(wardrobe?.planned).toBe(false);
    expect(wardrobe?.jobIds).toEqual(["phase1", "resumed"]);
    expect(wardrobe?.evidence?.artifactPaths).toEqual([phase1.path, resumed.path]);
    expect(report.findings.some((finding) => finding.topic === "wardrobe" && finding.class === "unverified" && finding.jobIds.includes("legacy"))).toBe(true);

    const aspect = report.findings.find((finding) => finding.summary.includes("settings.aspectRatio"));
    expect(aspect?.class).toBe("measured");
    const style = report.findings.find((finding) => finding.summary.includes("ledger.promptStyle"));
    expect(style?.class).toBe("unverified");
    expect(style?.summary).not.toMatch(/differs/);

    const props = report.findings.find((finding) => finding.topic === "location-props" && finding.class === "measured");
    expect(props?.evidence?.method).toBe("ledger-prop-signature");
    expect(props?.evidence?.value).toBe("kitchen");

    const lineage = report.findings.filter((finding) => finding.topic === "lineage" && finding.class === "measured");
    expect(lineage.map((finding) => finding.summary).join("\n")).toContain("resumed from phase1");
    expect(lineage.map((finding) => finding.summary).join("\n")).toContain("repaired shot 1 of resumed");

    const identity = report.findings.filter((finding) => finding.topic === "identity");
    expect(identity.some((finding) => finding.class === "measured" && finding.evidence?.method === "face")).toBe(false);
    expect(identity.some((finding) => finding.abstention === "character reference version not recorded on this film")).toBe(true);
    expect(identity.some((finding) => finding.summary.includes("No first frame on disk"))).toBe(true);
    for (const finding of report.findings) {
      expect(finding.evidence || finding.abstention).toBeTruthy();
    }
  });

  it("marks an intentional wardrobe difference as planned and still does not edit the films", async () => {
    const report = await checkCrossFilm(input([phase1, resumed], { intentionalWardrobeDifference: true }));
    const wardrobe = report.findings.find((finding) => finding.topic === "wardrobe" && finding.class === "measured");
    expect(wardrobe?.planned).toBe(true);
    expect(report.mutatedPaths).toEqual([]);
  });

  it("kills mutation: dropping the abstention on a missing frame or ledger", async () => {
    const bare = job({ id: "bare" });
    const dressed = job({
      id: "dressed",
      ledger: {
        shots: [{ shot: 1, checklists: [{ character: "Ada", worn: [{ id: "coat" }] }] }],
      },
    });
    const report = await checkCrossFilm(input([bare, dressed]));
    const wardrobe = report.findings.filter((finding) => finding.topic === "wardrobe");
    expect(wardrobe.some((finding) => finding.class === "measured")).toBe(false);
    expect(wardrobe.filter((finding) => finding.class === "unverified").length).toBeGreaterThan(0);
    const frames = report.findings.filter((finding) => finding.summary.includes("No first frame"));
    expect(frames.every((finding) => finding.class === "unverified")).toBe(true);
    expect(frames.some((finding) => finding.class === "measured")).toBe(false);
  });

  it("scores two on-disk frames as grayscale correlation and never as a face match", async () => {
    const left = job({
      id: "left",
      shots: [{ index: 1, openingFramePath: "/frames/a.png" }],
    });
    const right = job({
      id: "right",
      shots: [{ index: 1, openingFramePath: "/frames/b.png" }],
    });
    const report = await checkCrossFilm(input([left, right], {
      characters: new Map(),
      fileExists: (file) => file.endsWith(".png"),
      filesIdentical: () => false,
      correlate: async () => 0.25,
      resolveFirstFrame: async (entry) => ({
        path: entry.shots?.[0]?.openingFramePath,
        cited: entry.shots?.[0]?.openingFramePath ?? entry.path,
        ephemeral: false,
      }),
    }));
    const score = report.findings.find((finding) => finding.evidence?.method === "32x32-grayscale-correlation");
    expect(score?.class).toBe("measured");
    expect(score?.summary).toContain("not a face match");
    expect(score?.evidence?.value).toBe(0.25);
  });

  it("calls identical bytes a sha256 match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theshow-frames-"));
    const file = path.join(dir, "same.bin");
    await writeFile(file, "same-bytes");
    const left = job({ id: "l", shots: [{ index: 1, openingFramePath: file }] });
    const right = job({ id: "r", shots: [{ index: 1, openingFramePath: file }] });
    const report = await checkCrossFilm(input([left, right], {
      characters: new Map(),
      fileExists: () => true,
      filesIdentical: (a, b) => {
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        return hash(a) === hash(b);
      },
      resolveFirstFrame: async (entry) => ({
        path: entry.shots?.[0]?.openingFramePath,
        cited: entry.shots?.[0]?.openingFramePath ?? entry.path,
        ephemeral: false,
      }),
    }));
    const match = report.findings.find((finding) => finding.summary.includes("byte-identical"));
    expect(match?.class).toBe("measured");
    expect(match?.evidence?.method).toBe("sha256");
  });

  it("refuses a set outside 2 to 20 and does not invent a series", async () => {
    const one = await checkCrossFilm(input([legacy]));
    expect(one.error).toMatch(/Need 2/);
    const many = Array.from({ length: 21 }, (_, index) => job({ id: `f${index}` }));
    const over = await checkCrossFilm(input(many, { characters: new Map() }));
    expect(over.error).toMatch(/at most 20/);
    expect(over.findings).toEqual([]);
  });

  it("does not import a write path", async () => {
    const source = await readFile(path.join(process.cwd(), "mcp/crossFilm.ts"), "utf8");
    expect(source).not.toContain("refreshJobsFromDisk");
    expect(source).not.toContain("persistJob");
    expect(source).not.toContain("claimFilm");
    expect(source).not.toContain("saveJobAnnotation");
  });

  it("F1: two films with empty reference snapshots do not count as a hash match", async () => {
    const empty = (id: string) => job({
      id,
      characterSnapshots: [{ name: "Ada", updatedAt: "2024-06-01T00:00:00.000Z", references: [] }],
    });
    const report = await checkCrossFilm(input([empty("a"), empty("b")], { characters: new Map() }));
    const identity = report.findings.filter((finding) => finding.topic === "identity" && finding.summary.toLowerCase().includes("ada"));
    expect(identity.some((finding) => finding.class === "measured")).toBe(false);
    expect(identity.some((finding) => finding.summary.includes("match"))).toBe(false);
    expect(identity.every((finding) => finding.class === "unverified")).toBe(true);
    expect(identity[0]?.abstention).toMatch(/no local reference hashed/);
  });

  it("P26: stored hashes say match or differ, and the words are not swapped", async () => {
    const withHashes = (id: string, sha256: string) => job({
      id,
      characterSnapshots: [{ name: "Ada", updatedAt: "2024-06-01T00:00:00.000Z", references: [{ path: "/r.png", sha256 }] }],
    });
    const same = await checkCrossFilm(input([withHashes("a", "abc"), withHashes("b", "abc")], { characters: new Map() }));
    const different = await checkCrossFilm(input([withHashes("a", "abc"), withHashes("b", "def")], { characters: new Map() }));
    const sameFinding = same.findings.find((finding) => finding.topic === "identity" && finding.evidence?.method === "sha256");
    const differentFinding = different.findings.find((finding) => finding.topic === "identity" && finding.evidence?.method === "sha256");
    expect(sameFinding?.class).toBe("measured");
    expect(sameFinding?.evidence?.value).toBe("identical");
    expect(sameFinding?.summary).toContain("match");
    expect(sameFinding?.summary).not.toContain("differ");
    expect(differentFinding?.class).toBe("measured");
    expect(differentFinding?.evidence?.value).toBe("differs");
    expect(differentFinding?.summary).toContain("differ");
  });

  it("F7: equal settings produce no differs finding, and each field differs on its own", async () => {
    const base = {
      aspectRatio: "16:9",
      resolution: "720p",
      model: "grok-imagine-video-1.5",
      pin: "start",
      voiceId: "rex",
      clipAudio: "keep",
      characters: ["Ada"],
    };
    const film = (id: string, settings: Partial<typeof base> = {}, promptStyle = "legacy") => job({
      id,
      settings: { ...base, ...settings },
      ledger: { promptStyle },
    });
    const equal = await checkCrossFilm(input([film("a"), film("b"), film("c")], { characters: new Map() }));
    expect(equal.findings.filter((finding) => finding.topic === "settings")).toEqual([]);

    const cases: Array<{ source: string; left: Partial<typeof base>; right: Partial<typeof base>; leftStyle?: string; rightStyle?: string }> = [
      { source: "settings.aspectRatio", left: { aspectRatio: "16:9" }, right: { aspectRatio: "9:16" } },
      { source: "settings.resolution", left: { resolution: "720p" }, right: { resolution: "480p" } },
      { source: "settings.model", left: { model: "grok-imagine-video-1.5" }, right: { model: "other-model" } },
      { source: "settings.pin", left: { pin: "start" }, right: { pin: "both" } },
      { source: "settings.voiceId", left: { voiceId: "rex" }, right: { voiceId: "sage" } },
      { source: "settings.clipAudio", left: { clipAudio: "keep" }, right: { clipAudio: "mute" } },
      { source: "ledger.promptStyle", left: {}, right: {}, leftStyle: "legacy", rightStyle: "sections-v2" },
    ];
    for (const entry of cases) {
      const report = await checkCrossFilm(input([
        film("left", entry.left, entry.leftStyle),
        film("right", entry.right, entry.rightStyle),
      ], { characters: new Map() }));
      const measured = report.findings.filter((finding) => finding.topic === "settings" && finding.class === "measured");
      expect(measured.map((finding) => finding.summary), entry.source).toEqual([`${entry.source} differs across these films.`]);
    }
  });

  it("F4: an unset setting is unverified, not a measured difference", async () => {
    const set = job({ id: "set", settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", pin: "start", characters: ["Ada"] } });
    const unset = job({ id: "unset", settings: { resolution: "720p", model: "grok-imagine-video-1.5", pin: "start", characters: ["Ada"] } });
    const report = await checkCrossFilm(input([set, unset], { characters: new Map() }));
    const aspect = report.findings.filter((finding) => finding.summary.includes("aspectRatio"));
    expect(aspect.some((finding) => finding.class === "measured")).toBe(false);
    expect(aspect[0]?.class).toBe("unverified");
    const both = await checkCrossFilm(input([
      job({ id: "wide", settings: { aspectRatio: "16:9", resolution: "720p", model: "m", pin: "start", characters: ["Ada"] } }),
      job({ id: "tall", settings: { aspectRatio: "9:16", resolution: "720p", model: "m", pin: "start", characters: ["Ada"] } }),
    ], { characters: new Map() }));
    const measuredAspect = both.findings.find((finding) => finding.summary.includes("settings.aspectRatio"));
    expect(measuredAspect?.class).toBe("measured");
  });

  it("F5: a character missing from the first-shot checklist is not 'wearing nothing'", async () => {
    const listed = job({
      id: "listed",
      ledger: { shots: [{ shot: 1, checklists: [{ character: "Ada", worn: [{ id: "coat" }] }] }] },
    });
    const omitted = job({
      id: "omitted",
      ledger: { shots: [{ shot: 1, checklists: [{ character: "Bea", worn: [{ id: "hat" }] }] }] },
    });
    const report = await checkCrossFilm(input([listed, omitted], { characters: new Map() }));
    const ada = report.findings.filter((finding) => finding.topic === "wardrobe" && finding.summary.toLowerCase().includes("ada"));
    expect(ada.some((finding) => finding.class === "measured")).toBe(false);
    expect(ada.some((finding) => finding.class === "unverified" && finding.jobIds.includes("omitted"))).toBe(true);
  });

  it("frames that cannot be correlated are visually flagged, not scored", async () => {
    const left = job({ id: "left", shots: [{ index: 1, openingFramePath: "/frames/a.png" }] });
    const right = job({ id: "right", shots: [{ index: 1, openingFramePath: "/frames/b.png" }] });
    const report = await checkCrossFilm(input([left, right], {
      characters: new Map(),
      fileExists: () => true,
      filesIdentical: () => false,
      correlate: async () => undefined,
      resolveFirstFrame: async (entry) => ({
        path: entry.shots?.[0]?.openingFramePath,
        cited: entry.shots?.[0]?.openingFramePath ?? entry.path,
        ephemeral: false,
      }),
    }));
    const flagged = report.findings.find((finding) => finding.class === "visually-flagged");
    expect(flagged?.evidence?.method).toBe("32x32-grayscale-correlation");
    expect(flagged?.evidence?.value).toBeUndefined();
    expect(report.findings.some((finding) => finding.class === "measured" && finding.evidence?.method === "32x32-grayscale-correlation")).toBe(false);
  });

  it("P27: a named frame that is not on disk stays unverified", async () => {
    const left = job({ id: "left", shots: [{ index: 1, openingFramePath: "/frames/missing-a.png" }] });
    const right = job({ id: "right", shots: [{ index: 1, openingFramePath: "/frames/missing-b.png" }] });
    const report = await checkCrossFilm(input([left, right], {
      characters: new Map(),
      fileExists: () => false,
      filesIdentical: () => false,
      correlate: async () => {
        throw new Error("missing frame");
      },
      resolveFirstFrame: async (entry) => ({
        path: entry.shots?.[0]?.openingFramePath,
        cited: entry.shots?.[0]?.openingFramePath ?? entry.path,
        ephemeral: false,
      }),
    }));
    const frames = report.findings.filter((finding) => finding.summary.includes("No first frame on disk"));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.class).toBe("unverified");
    expect(report.findings.some((finding) => finding.class === "visually-flagged")).toBe(false);
  });

  it("rejects a consistency directory inside the jobs directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "theshow-safe-"));
    const jobs = path.join(root, "jobs");
    await mkdir(jobs);
    expect(consistencyDirIsSafe(path.join(root, "consistency"), jobs)).toBe(true);
    expect(consistencyDirIsSafe(jobs, jobs)).toBe(false);
    expect(consistencyDirIsSafe(path.join(jobs, "nested"), jobs)).toBe(false);
  });
});

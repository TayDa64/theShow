/**
 * Read-only comparison of two or more films.
 *
 * The caller loads job files, character records, and frames. This module does
 * not refresh the job store, claim a film, or write a job. A grayscale score
 * is a 32×32 correlation, never a face match.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { FindingClass } from "./continuityReview.ts";

export const CROSS_FILM_VERSION = 1 as const;
export const CROSS_FILM_MIN = 2;
export const CROSS_FILM_MAX = 20;

export function consistencyDirectory(): string {
  return process.env.THESHOW_CONSISTENCY_DIR || join(homedir(), ".theshow", "consistency");
}

/** A report directory inside JOBS_DIR would be loaded as films if a file there had an id. */
export function consistencyDirIsSafe(dir: string, jobsDir: string): boolean {
  const target = resolve(dir);
  const jobs = resolve(jobsDir);
  if (target === jobs) return false;
  const fromJobs = relative(jobs, target);
  if (fromJobs === "" || (!fromJobs.startsWith(`..${sep}`) && fromJobs !== ".." && !isAbsolute(fromJobs))) {
    return false;
  }
  return true;
}

const wornSchema = z.object({ id: z.string() }).passthrough();
const checklistSchema = z.object({
  character: z.string(),
  worn: z.array(wornSchema).optional(),
}).passthrough();
const propSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  name: z.string().optional(),
  placement: z.string().optional(),
  holder: z.string().optional(),
  count: z.number().optional(),
  fixed: z.boolean().optional(),
}).passthrough();

const jobSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number(),
  state: z.string().optional(),
  spentUsd: z.number().optional(),
  shots: z.array(z.object({
    index: z.number(),
    openingFramePath: z.string().optional(),
    localPath: z.string().optional(),
    shotType: z.string().optional(),
    framing: z.string().optional(),
    durationSeconds: z.number().optional(),
    title: z.string().optional(),
  }).passthrough()).optional(),
  settings: z.object({
    aspectRatio: z.string().optional(),
    resolution: z.string().optional(),
    model: z.string().optional(),
    pin: z.string().optional(),
    voiceId: z.string().optional(),
    clipAudio: z.string().optional(),
    characters: z.array(z.string()).optional(),
  }).passthrough().optional(),
  ledger: z.object({
    promptStyle: z.string().optional(),
    props: z.array(propSchema).optional(),
    shots: z.array(z.object({
      shot: z.number().optional(),
      locationId: z.string().optional(),
      checklists: z.array(checklistSchema).optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  resumedFrom: z.object({ jobId: z.string(), fromShot: z.number() }).optional(),
  repairedFrom: z.object({
    jobId: z.string(),
    shotIndex: z.number(),
    originalCostUsd: z.number().optional(),
  }).optional(),
  spendLedger: z.object({
    appliedNoteIds: z.array(z.string()).optional(),
  }).passthrough().optional(),
  characterSnapshots: z.array(z.object({
    name: z.string(),
    updatedAt: z.string(),
    references: z.array(z.object({ path: z.string(), sha256: z.string() })),
  })).optional(),
});

export type CrossFilmJob = z.infer<typeof jobSchema> & { path: string };

export type CrossFilmEvidence = {
  method: string;
  artifactPaths: string[];
  value?: string | number;
  ephemeral?: boolean;
};

export type CrossFilmFinding = {
  topic: "character-record" | "wardrobe" | "settings" | "location-props" | "identity" | "lineage";
  class: FindingClass;
  summary: string;
  jobIds: string[];
  evidence?: CrossFilmEvidence;
  abstention?: string;
  planned?: boolean;
};

export type CrossFilmFilm = {
  jobId: string;
  path: string;
  startedAt: number;
  state: string | null;
  spentUsd: number;
  pendingSpendUsd: number;
};

export type CrossFilmReport = {
  version: typeof CROSS_FILM_VERSION;
  executed: false;
  willRender: false;
  willSpend: false;
  mutatedPaths: [];
  findings: CrossFilmFinding[];
  films: CrossFilmFilm[];
  persisted: boolean;
  error?: string;
};

export type CharacterFact = {
  name: string;
  updatedAt: string;
  path: string;
};

export type ResolvedFrame = {
  path?: string;
  cited: string;
  ephemeral: boolean;
};

export type CrossFilmInput = {
  jobs: CrossFilmJob[];
  missingJobIds?: string[];
  characters: Map<string, CharacterFact | undefined>;
  pendingSpendUsd: Map<string, number>;
  intentionalWardrobeDifference: boolean;
  fileExists: (path: string) => boolean;
  filesIdentical: (left: string, right: string) => boolean;
  correlate: (left: string, right: string) => Promise<number | undefined>;
  resolveFirstFrame: (job: CrossFilmJob) => Promise<ResolvedFrame>;
};

export function parseCrossFilmJob(value: unknown, path: string): CrossFilmJob | undefined {
  const parsed = jobSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { ...parsed.data, path };
}

export function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function measured(
  topic: CrossFilmFinding["topic"],
  jobIds: string[],
  summary: string,
  evidence: CrossFilmEvidence,
  planned?: boolean,
): CrossFilmFinding {
  return {
    topic,
    class: "measured",
    summary,
    jobIds,
    evidence,
    ...(planned !== undefined ? { planned } : {}),
  };
}

function unverified(
  topic: CrossFilmFinding["topic"],
  jobIds: string[],
  reason: string,
  paths: string[],
): CrossFilmFinding {
  return {
    topic,
    class: "unverified",
    summary: reason,
    jobIds,
    abstention: reason,
    evidence: { method: "abstain", artifactPaths: paths },
  };
}

function visuallyFlagged(
  topic: CrossFilmFinding["topic"],
  jobIds: string[],
  summary: string,
  evidence: CrossFilmEvidence,
): CrossFilmFinding {
  return { topic, class: "visually-flagged", summary, jobIds, evidence };
}

function characterDrift(input: CrossFilmInput): CrossFilmFinding[] {
  const findings: CrossFilmFinding[] = [];
  for (const job of input.jobs) {
    const names = job.settings?.characters ?? [];
    for (const name of names) {
      const fact = input.characters.get(name.trim().toLowerCase());
      if (!fact) {
        findings.push(unverified(
          "character-record",
          [job.id],
          `No character record on disk for ${name}.`,
          [job.path],
        ));
        continue;
      }
      const updated = Date.parse(fact.updatedAt);
      if (!Number.isFinite(updated)) {
        findings.push(unverified(
          "character-record",
          [job.id],
          `character.json updatedAt for ${fact.name} is not a time.`,
          [job.path, fact.path],
        ));
        continue;
      }
      const changed = updated > job.startedAt;
      findings.push(measured(
        "character-record",
        [job.id],
        changed
          ? `${fact.name} changed after this film.`
          : `${fact.name} character.json updatedAt is not later than this film.`,
        {
          method: "character-updatedAt",
          artifactPaths: [job.path, fact.path],
          value: `${fact.updatedAt} vs ${new Date(job.startedAt).toISOString()}`,
        },
      ));
      if (changed) {
        findings.push(unverified(
          "character-record",
          [job.id],
          "What changed is not stored. The character record has no history.",
          [fact.path],
        ));
      }
    }
  }
  return findings;
}

function wornMap(job: CrossFilmJob): Map<string, string[]> | undefined {
  const shot = job.ledger?.shots?.[0];
  if (!shot?.checklists) return undefined;
  const map = new Map<string, string[]>();
  for (const list of shot.checklists) {
    const ids = (list.worn ?? []).map((layer) => layer.id.trim()).filter(Boolean).sort();
    map.set(list.character.trim().toLowerCase(), ids);
  }
  return map;
}

function wardrobe(input: CrossFilmInput): CrossFilmFinding[] {
  const findings: CrossFilmFinding[] = [];
  const maps = new Map<string, Map<string, string[]> | undefined>();
  for (const job of input.jobs) {
    const worn = wornMap(job);
    maps.set(job.id, worn);
    if (!worn) {
      findings.push(unverified(
        "wardrobe",
        [job.id],
        "No wardrobe ledger on this film.",
        [job.path],
      ));
    }
  }
  const names = new Set<string>();
  for (const worn of maps.values()) {
    if (!worn) continue;
    for (const name of worn.keys()) names.add(name);
  }
  const withLedger = input.jobs.filter((job) => maps.get(job.id));
  for (const name of names) {
    const rows = withLedger.map((job) => ({
      job,
      ids: maps.get(job.id)?.get(name) ?? [],
    }));
    const signatures = new Set(rows.map((row) => row.ids.join(",")));
    if (signatures.size <= 1) continue;
    findings.push(measured(
      "wardrobe",
      rows.map((row) => row.job.id),
      `First-shot worn layers for ${name} differ across these films.`,
      {
        method: "ledger-worn-ids",
        artifactPaths: rows.map((row) => row.job.path),
        value: rows.map((row) => `${row.job.id}=[${row.ids.join(",")}]`).join(" ; "),
      },
      input.intentionalWardrobeDifference,
    ));
  }
  return findings;
}

type SettingField = "aspectRatio" | "resolution" | "model" | "pin" | "voiceId" | "clipAudio" | "promptStyle";

const SETTING_FIELDS: readonly SettingField[] = [
  "aspectRatio",
  "resolution",
  "model",
  "pin",
  "voiceId",
  "clipAudio",
  "promptStyle",
];

function settingValue(job: CrossFilmJob, field: SettingField): string | null {
  if (field === "promptStyle") return job.ledger?.promptStyle ?? null;
  return job.settings?.[field] ?? null;
}

function settingsDiffs(input: CrossFilmInput): CrossFilmFinding[] {
  const findings: CrossFilmFinding[] = [];
  for (const field of SETTING_FIELDS) {
    const values = input.jobs.map((job) => settingValue(job, field));
    const distinct = new Set(values.map((value) => value ?? ""));
    if (distinct.size <= 1) continue;
    const source = field === "promptStyle" ? "ledger.promptStyle" : `settings.${field}`;
    findings.push(measured(
      "settings",
      input.jobs.map((job) => job.id),
      `${source} differs across these films.`,
      {
        method: "settings-field",
        artifactPaths: input.jobs.map((job) => job.path),
        value: input.jobs.map((job, index) => `${job.id}=${values[index] ?? "unset"}`).join(" ; "),
      },
    ));
  }
  return findings;
}

function propSignature(prop: {
  id: string;
  name?: string;
  placement?: string;
  holder?: string;
  count?: number;
  fixed?: boolean;
}): string {
  return [
    prop.id,
    prop.name ?? "",
    prop.placement ?? "",
    prop.holder ?? "",
    prop.count ?? "",
    prop.fixed === undefined ? "" : String(prop.fixed),
  ].join("|");
}

function locationProps(input: CrossFilmInput): CrossFilmFinding[] {
  const findings: CrossFilmFinding[] = [];
  const byJob = new Map<string, Map<string, string[]> | undefined>();
  for (const job of input.jobs) {
    if (!job.ledger) {
      byJob.set(job.id, undefined);
      findings.push(unverified(
        "location-props",
        [job.id],
        "No prop ledger on this film.",
        [job.path],
      ));
      continue;
    }
    const grouped = new Map<string, string[]>();
    for (const prop of job.ledger.props ?? []) {
      const list = grouped.get(prop.locationId) ?? [];
      list.push(propSignature(prop));
      grouped.set(prop.locationId, list);
    }
    for (const [location, list] of grouped) grouped.set(location, [...list].sort());
    byJob.set(job.id, grouped);
  }
  const locations = new Set<string>();
  for (const grouped of byJob.values()) {
    if (!grouped) continue;
    for (const location of grouped.keys()) locations.add(location);
  }
  for (const location of locations) {
    const rows = input.jobs.flatMap((job) => {
      const grouped = byJob.get(job.id);
      if (!grouped || !grouped.has(location)) return [];
      return [{ job, signature: (grouped.get(location) ?? []).join("||") }];
    });
    if (rows.length < 2) continue;
    const distinct = new Set(rows.map((row) => row.signature));
    if (distinct.size <= 1) continue;
    findings.push(measured(
      "location-props",
      rows.map((row) => row.job.id),
      `Props for location ${location} differ across these films.`,
      {
        method: "ledger-prop-signature",
        artifactPaths: rows.map((row) => row.job.path),
        value: location,
      },
    ));
  }
  return findings;
}

function snapshotKey(job: CrossFilmJob, name: string): string | undefined {
  const snap = job.characterSnapshots?.find((entry) => namesMatch(entry.name, name));
  if (!snap) return undefined;
  return snap.references.map((ref) => ref.sha256).sort().join(",");
}

function referenceIdentity(input: CrossFilmInput): CrossFilmFinding[] {
  const names = new Set<string>();
  for (const job of input.jobs) {
    for (const name of job.settings?.characters ?? []) names.add(name.trim().toLowerCase());
    for (const snap of job.characterSnapshots ?? []) names.add(snap.name.trim().toLowerCase());
  }
  if (names.size === 0) return [];
  const findings: CrossFilmFinding[] = [];
  for (const name of names) {
    const rows = input.jobs.map((job) => ({ job, key: snapshotKey(job, name) }));
    const recorded = rows.filter((row) => row.key !== undefined);
    const missing = rows.filter((row) => row.key === undefined);
    if (missing.length > 0) {
      findings.push(unverified(
        "identity",
        missing.map((row) => row.job.id),
        "character reference version not recorded on this film",
        missing.map((row) => row.job.path),
      ));
    }
    if (recorded.length < 2) continue;
    const distinct = new Set(recorded.map((row) => row.key));
    findings.push(measured(
      "identity",
      recorded.map((row) => row.job.id),
      distinct.size > 1
        ? `Stored reference hashes for ${name} differ. This is sha256 of the files recorded on the job, not a face match.`
        : `Stored reference hashes for ${name} match. This is sha256 of the files recorded on the job, not a face match.`,
      {
        method: "sha256",
        artifactPaths: recorded.map((row) => row.job.path),
        value: distinct.size > 1 ? "differs" : "identical",
      },
    ));
  }
  return findings;
}

async function frameIdentity(input: CrossFilmInput): Promise<CrossFilmFinding[]> {
  if (input.jobs.length < 2) return [];
  const frames = new Map<string, ResolvedFrame>();
  for (const job of input.jobs) frames.set(job.id, await input.resolveFirstFrame(job));
  const findings: CrossFilmFinding[] = [];
  const first = input.jobs[0];
  const firstFrame = frames.get(first.id);
  for (const job of input.jobs.slice(1)) {
    const other = frames.get(job.id);
    const pair = [first, job];
    const paths = [firstFrame?.cited, other?.cited].filter((path): path is string => Boolean(path));
    if (!firstFrame?.path || !other?.path || !input.fileExists(firstFrame.path) || !input.fileExists(other.path)) {
      findings.push(unverified(
        "identity",
        pair.map((entry) => entry.id),
        "No first frame on disk for one of these films, so identity was not compared.",
        paths.length > 0 ? paths : pair.map((entry) => entry.path),
      ));
      continue;
    }
    const artifactPaths = [firstFrame.cited, other.cited];
    const ephemeral = firstFrame.ephemeral || other.ephemeral;
    if (input.filesIdentical(firstFrame.path, other.path)) {
      findings.push(measured(
        "identity",
        pair.map((entry) => entry.id),
        "The first frames are byte-identical. This is sha256, not a face match.",
        { method: "sha256", artifactPaths, value: "identical", ...(ephemeral ? { ephemeral } : {}) },
      ));
      continue;
    }
    let score: number | undefined;
    try {
      score = await input.correlate(firstFrame.path, other.path);
    } catch {
      score = undefined;
    }
    if (typeof score === "number" && Number.isFinite(score)) {
      findings.push(measured(
        "identity",
        pair.map((entry) => entry.id),
        `32×32 grayscale correlation of the first frames is ${score}. This is not a face match.`,
        {
          method: "32x32-grayscale-correlation",
          artifactPaths,
          value: score,
          ...(ephemeral ? { ephemeral } : {}),
        },
      ));
      continue;
    }
    findings.push(visuallyFlagged(
      "identity",
      pair.map((entry) => entry.id),
      "Both first frames are on disk and the 32×32 grayscale correlation could not be scored. This is not a face match.",
      { method: "32x32-grayscale-correlation", artifactPaths, ...(ephemeral ? { ephemeral } : {}) },
    ));
  }
  return findings;
}

function lineage(input: CrossFilmInput): CrossFilmFinding[] {
  const known = new Set(input.jobs.map((job) => job.id));
  const findings: CrossFilmFinding[] = [];
  for (const job of input.jobs) {
    if (job.resumedFrom) {
      findings.push(measured(
        "lineage",
        [job.id],
        `${job.id} resumed from ${job.resumedFrom.jobId} at shot ${job.resumedFrom.fromShot}.`,
        {
          method: "job-field",
          artifactPaths: [job.path],
          value: known.has(job.resumedFrom.jobId) ? "parent-in-set" : job.resumedFrom.jobId,
        },
      ));
    }
    if (job.repairedFrom) {
      findings.push(measured(
        "lineage",
        [job.id],
        `${job.id} repaired shot ${job.repairedFrom.shotIndex} of ${job.repairedFrom.jobId}.`,
        {
          method: "job-field",
          artifactPaths: [job.path],
          value: known.has(job.repairedFrom.jobId) ? "parent-in-set" : job.repairedFrom.jobId,
        },
      ));
    }
  }
  return findings;
}

function filmRows(input: CrossFilmInput): CrossFilmFilm[] {
  return input.jobs.map((job) => ({
    jobId: job.id,
    path: job.path,
    startedAt: job.startedAt,
    state: job.state ?? null,
    spentUsd: typeof job.spentUsd === "number" ? Math.round(job.spentUsd * 100) / 100 : 0,
    pendingSpendUsd: input.pendingSpendUsd.get(job.id) ?? 0,
  }));
}

export async function checkCrossFilm(input: CrossFilmInput): Promise<CrossFilmReport> {
  const missing = input.missingJobIds ?? [];
  const missingFindings = missing.map((id) => unverified(
    "lineage",
    [id],
    "Job file not on disk.",
    [],
  ));
  if (input.jobs.length < CROSS_FILM_MIN) {
    return {
      version: CROSS_FILM_VERSION,
      executed: false,
      willRender: false,
      willSpend: false,
      mutatedPaths: [],
      findings: missingFindings,
      films: filmRows(input),
      persisted: false,
      error: `Need ${CROSS_FILM_MIN} to ${CROSS_FILM_MAX} films. ${input.jobs.length} could be read.`,
    };
  }
  if (input.jobs.length > CROSS_FILM_MAX) {
    return {
      version: CROSS_FILM_VERSION,
      executed: false,
      willRender: false,
      willSpend: false,
      mutatedPaths: [],
      findings: [],
      films: [],
      persisted: false,
      error: `${input.jobs.length} films match. Pass an explicit list of at most ${CROSS_FILM_MAX}.`,
    };
  }
  const frames = await frameIdentity(input);
  return {
    version: CROSS_FILM_VERSION,
    executed: false,
    willRender: false,
    willSpend: false,
    mutatedPaths: [],
    findings: [
      ...missingFindings,
      ...characterDrift(input),
      ...wardrobe(input),
      ...settingsDiffs(input),
      ...locationProps(input),
      ...referenceIdentity(input),
      ...frames,
      ...lineage(input),
    ],
    films: filmRows(input),
    persisted: false,
  };
}

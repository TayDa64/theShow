#!/usr/bin/env tsx
/**
 * theShow MCP Server (enhanced for testing)
 * - Stubs for most tools
 * - generate_controlled_clip calls the real Grok Imagine Video backend, through
 *   mcp/grokVideo.ts so the app's HTTP route shares the same implementation.
 *
 * createTheShowServer builds a server and registers the same tools. startStdioServer
 * is the desktop entry: it loads saved films and characters, then connects that
 * server over stdio. Importing this module does not open a port. mcp/stdio-main.ts
 * calls startStdioServer. mcp/http-server.ts is the Streamable HTTP entry and is
 * bundled apart from the stdio server so the desktop bundle does not include that stack.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { acceptRenderedTake, TakeAdmissionSchema, type TakeReport } from "./admission.ts";
import { resolveBeatDuration, resolveBeatShotType } from "./beats.ts";
import { featheredSubjectCutout } from "./cutout.ts";
import { ensureCredentialForJob, resolveVideoCredential } from "./grok-auth.ts";
import { lintSentPrompt } from "./promptLint.ts";
import { renderSectionsV2, shouldAnchorFace } from "./promptSections.ts";
import {
  CLOSING_FRAME_MATCH_THRESHOLD,
  JOBS_DIR,
  OUTPUT_DIR,
  assembleClips,
  closingFrameAgreement,
  extractFirstFrame,
  extractLastFrame,
  grayscaleStillCorrelation,
  pathToDataUrl,
  probeDuration,
} from "./media.ts";
import {
  costUsdFromUsage,
  generateGrokClip,
  generateGrokStill,
  localImageRefAllowed,
  paidStubEnabled,
  type GrokClipResult,
} from "./grokVideo.ts";
import { STILL_USD, boardFilm, planBoardFrames, toRenderShots } from "./storyboard.ts";
import {
  gatePaidAction,
  quoteFingerprint,
  videoQuote,
  type PaidAction,
  type PersistedSpend,
  type SpendKind,
} from "./costGate.ts";
import {
  reviewContinuity,
  type ContinuityReview,
  type ReviewShot,
} from "./continuityReview.ts";
import {
  coverageShotsFromJob,
  suggestCoverage,
  type CoverageShot,
} from "./coverageSuggestions.ts";
import {
  checkCrossFilm,
  consistencyDirIsSafe,
  consistencyDirectory,
  crossFilmParseError,
  namesMatch,
  parseCrossFilmJob,
  CROSS_FILM_MAX,
  CROSS_FILM_MIN,
  type CrossFilmJob,
  type CrossFilmReport,
} from "./crossFilm.ts";
import {
  buildDependencyGraph,
  proposeRepair,
  type DependencyGraph,
  type DependencyShot,
  type RepairProposal,
} from "./repairPlan.ts";
import { charactersRoot, loadCharacter, loadCharacterSync, loadAllCharacters, saveCharacter, snapshotCharacter } from "./characters.ts";
import {
  annotateAction,
  characterFromRecord,
  replayContinuity,
  type CharacterWardrobe,
  type ContinuityPlan,
  type LocationRecord,
  type PropEvent,
  type PropRecord,
  type ShotContinuity,
  type WardrobeEvent,
} from "./continuity.ts";
import {
  RENDER_BLOCKED_BY_CONTRACT,
  RENDER_UNCHECKED,
  decideSpend,
  messageForBoard,
  gateRenderSequence,
  promptFromContract,
  deriveContracts,
  runPreVideoGate,
  type RenderGateResult,
  type ShotContract,
} from "./contracts.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { noteJobPersisted, waitForJobEvents } from "./jobEvents.ts";
import {
  listJournal,
  productionFeedResultSchema,
  readProductionFeed,
  readQueuedFilmSpend,
  spendJournalDir,
  type QueuedFilmSpend,
  type SpendNote,
  type SpendNoteInput,
} from "./productionFeed.ts";
export { readQueuedFilmSpend };
export type { QueuedFilmSpend };
import { runResumeClaimProbe } from "./resume-claim-probe.ts";
import {
  atomicWriteFile,
  currentMcpServer,
  sweepOrphanTemps,
  sweepStaleReviewFrames,
  hostKey,
  elicitTimeoutMs,
  flushJobWrites,
  installShutdown,
  jobShouldStop,
  pidAlive,
  processHost,
  processToken,
  publishExclusive,
  restoreIfAbsent,
  requestScope,
  startJobHeartbeat,
  thisOwner,
  toolAuth,
  trackWrite,
  withoutHttpRenderMemo,
  type JobOwner,
} from "./runtime.ts";

export const server = new McpServer({
  name: "theshow",
  version: "0.1.0",
});

type RecordedTool = {
  name: string;
  config: Parameters<McpServer["registerTool"]>[1];
  handler: Parameters<McpServer["registerTool"]>[2];
};

const recordedTools: RecordedTool[] = [];
const registerRecordedTool = server.registerTool.bind(server);
server.registerTool = ((name: string, config: RecordedTool["config"], handler: RecordedTool["handler"]) => {
  recordedTools.push({ name, config, handler });
  return registerRecordedTool(name, config, handler);
}) as McpServer["registerTool"];

/** A second MCP server with the same tools, for one HTTP session. */
export function createTheShowServer(): McpServer {
  const next = new McpServer({ name: "theshow", version: "0.1.0" });
  for (const tool of recordedTools) next.registerTool(tool.name, tool.config, tool.handler);
  return next;
}

const CharacterSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  appearance: z.string().optional().describe(
    "Identity only: face, hair, skin, build. Clothing belongs in wardrobe.layers.",
  ),
  wardrobe: z.object({
    layers: z.array(z.object({
      id: z.string(),
      item: z.string(),
      order: z.number().describe("Inner to outer within this layer type."),
      inReference: z.enum(["visible", "partial", "hidden"]),
      type: z.enum(["clothing", "footwear"]).optional().describe(
        "Clothing and footwear stack separately. Defaults to clothing.",
      ),
      closure: z.enum(["zip", "buttons", "open", "laced", "slip-on", "none"]).optional(),
      mustNotHave: z.array(z.string()).optional(),
      short: z.string().optional(),
    })).min(1),
    startState: z.object({
      worn: z.array(z.string()).describe("Layer ids worn at the start of the film."),
    }).optional(),
    stateImages: z.array(z.object({
      worn: z.array(z.string()),
      referenceImageUrls: z.array(z.string()),
    })).optional().describe(
      "Optional photos of a later wardrobe state, such as the coat off.",
    ),
  }).optional(),
  // Deliberately not z.string().url(): a local path or a chat attachment has to
  // reach toApiImageRef, which inlines it as a data URI. Zod's .url() rejects
  // "/workspace/photo.png", so the same reference worked on
  // generate_controlled_clip and failed here with no useful message.
  referenceImageUrls: z.array(z.string()).optional().describe(
    "Portrait reference images: public https URLs, data URIs, or local file paths. " +
    "Each is inlined for the API, so a path from a chat attachment or extract_last_frame works.",
  ),
});

const WardrobeEventSchema = z.object({
  shot: z.number().int().min(1).optional().describe("1-based shot number. Implied when the event sits on a beat."),
  character: z.string().optional(),
  action: z.enum(["remove", "putOn", "adjust"]),
  layer: z.string().describe("Layer id from the character's wardrobe."),
  to: z.string().optional().describe(
    "For a removal, the destination prop id, or its name inside this shot's location.",
  ),
  note: z.string().optional(),
});

const PropRecordSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  name: z.string(),
  placement: z.string(),
  holder: z.string().optional(),
  fixed: z.boolean().optional(),
  count: z.number().int().min(0).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  solid: z.boolean().optional(),
  contact: z.enum(["hanging", "resting", "held"]).optional(),
});

const PropEventSchema = z.object({
  shot: z.number().int().min(1).optional(),
  action: z.enum(["add", "move", "remove"]),
  propId: z.string(),
  locationId: z.string().optional(),
  name: z.string().optional(),
  placement: z.string().optional(),
  holder: z.string().optional(),
});

const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const ShotStateSchema = z.object({
  worn: z.array(z.string()),
  holders: z.record(z.string(), z.string()),
  counts: z.record(z.string(), z.number()),
});

const ShotContractSchema = z.object({
  shot: z.number().int().min(1),
  requires: ShotStateSchema,
  steps: z.array(z.string()),
  ensures: ShotStateSchema,
  invariants: z.array(z.string()),
  forbidden: z.array(z.string()),
  footwear: z.array(z.string()).optional(),
});

/**
 * Characters, in memory for speed and on disk for survival.
 *
 * This used to be memory alone, which meant a character — including the
 * reference photos the user chose and the wardrobe they described — vanished
 * when the session ended. On a phone, where the whole flow is "drop a photo
 * into chat and use it later", that made the feature useless by the time the
 * later came. The map is now a cache in front of mcp/characters.ts.
 */
type StoredCharacter = {
  id: string;
  name: string;
  role?: string;
  description?: string;
  appearance?: string;
  wardrobe?: CharacterWardrobe;
  referenceImageUrls?: string[];
  updatedAt?: string;
};

const characterStore = new Map<string, StoredCharacter>();

async function rememberCharacter(args: z.infer<typeof CharacterSchema>) {
  const key = args.name.trim().toLowerCase();

  // Pass only the fields this call set. saveCharacter re-reads disk and keeps
  // the other fields, so a concurrent edit of a different field is not lost
  // to a stale cache entry.
  const saved = await saveCharacter({
    name: args.name,
    role: args.role,
    description: args.description,
    appearance: args.appearance,
    wardrobe: args.wardrobe,
    referenceImageUrls: args.referenceImageUrls,
  });

  const entry: StoredCharacter = {
    id: saved.id,
    name: saved.name,
    role: saved.role,
    description: saved.description,
    appearance: saved.appearance,
    wardrobe: saved.wardrobe,
    referenceImageUrls: saved.referenceImageUrls,
    updatedAt: saved.updatedAt,
  };
  characterStore.set(key, entry);
  return { entry, folder: saved.folder, warnings: saved.warnings };
}

function storedFrom(record: {
  id: string;
  name: string;
  role?: string;
  description?: string;
  appearance?: string;
  wardrobe?: CharacterWardrobe;
  referenceImageUrls?: string[];
  updatedAt?: string;
}): StoredCharacter {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    description: record.description,
    appearance: record.appearance,
    wardrobe: record.wardrobe,
    referenceImageUrls: record.referenceImageUrls,
    updatedAt: record.updatedAt,
  };
}

function lookupCharacter(name: string) {
  const key = name.trim().toLowerCase();
  // Disk wins when it is newer than the cache, including a write from the
  // other process. Synchronous because plan_storyboard and
  // mergeCharacterReferences are.
  const fromDisk = loadCharacterSync(name);
  if (!fromDisk) {
    characterStore.delete(key);
    return undefined;
  }
  const cached = characterStore.get(key);
  if (!cached || cached.updatedAt !== fromDisk.updatedAt) {
    characterStore.set(key, storedFrom(fromDisk));
  }
  return characterStore.get(key);
}

const LOCATION_ROLE = /\b(location|place|set|environment|interior|exterior)\b/i;

/**
 * Replace a person's local portrait with a feathered cutout. The original file
 * stays as it was. A location plate is not a portrait and is left alone. A
 * cutout that cannot be made keeps the original path so a missing ffmpeg does
 * not block a call the caller already approved.
 */
async function withPersonCutouts(
  names: string[] | undefined,
  urls: string[],
): Promise<string[]> {
  const portraits = new Set<string>();
  for (const name of names ?? []) {
    const known = lookupCharacter(name);
    if (!known) continue;
    if (LOCATION_ROLE.test(known.role ?? "")) continue;
    for (const url of known.referenceImageUrls ?? []) portraits.add(url);
  }
  const prepared: string[] = [];
  for (const url of urls) {
    const localPortrait = portraits.has(url)
      && !/^https?:/i.test(url)
      && !url.startsWith("data:");
    if (!localPortrait) {
      prepared.push(url);
      continue;
    }
    const cutout = await featheredSubjectCutout(url);
    prepared.push(cutout.ok ? cutout.path : url);
  }
  return prepared;
}

/** Pull every saved character into the cache so lookups start warm. */
export async function loadCharactersFromDisk() {
  try {
    for (const character of await loadAllCharacters()) {
      characterStore.set(character.name.trim().toLowerCase(), {
        id: character.id,
        name: character.name,
        role: character.role,
        description: character.description,
        appearance: character.appearance,
        wardrobe: character.wardrobe,
        referenceImageUrls: character.referenceImageUrls,
        updatedAt: character.updatedAt,
      });
    }
  } catch (err) {
    // A missing or unreadable characters directory is a first run, not a reason
    // to refuse to start. Lookups still fall back to disk one name at a time.
    console.error("theShow: could not load saved characters:", err);
  }
}

/**
 * Fold registered character portraits into a reference-image list.
 *
 * Shared by generate_controlled_clip, generate_still and board_film so all three
 * resolve a name the same way. Without it the references sit in the store while
 * the render runs blind, which is exactly how a film drifts off the character
 * the user supplied. Unknown names are reported back rather than dropped
 * silently.
 */
function mergeCharacterReferences(
  characters: string[] | undefined,
  referenceImageUrls: string[] | undefined,
): { urls: string[]; missing: string[] } {
  const fromCharacters: string[] = [];
  const missing: string[] = [];
  for (const name of characters ?? []) {
    const known = lookupCharacter(name);
    if (!known) { missing.push(name); continue; }
    fromCharacters.push(...(known.referenceImageUrls ?? []));
  }
  const merged = [...(referenceImageUrls ?? []), ...fromCharacters];
  return { urls: Array.from(new Set(merged)), missing };
}

/**
 * The picture the board should edit every frame from: the first portrait of the
 * first character whose role says it is a place.
 *
 * A location photo is the single best continuity anchor a board can have, and
 * it was previously passed in as just another reference, where the model treated
 * it as a loose hint and redrew the skyline in every frame. Measured on the same
 * five-shot board: chained frames agreed on the skyline at a mean 0.36, with a
 * worst pair of -0.31 (unrelated), while frames all edited from the office photo
 * agreed at 0.52. Picking this automatically means the fix arrives without the
 * caller having to know it exists.
 *
 * Only an explicit Location role qualifies. A character reference is a face to
 * graft onto a scene, never the scene itself.
 */
function locationScene(characters: string[] | undefined): string | undefined {
  for (const name of characters ?? []) {
    const known = lookupCharacter(name);
    if (!known?.description?.trim()) continue;
    if (!/\b(location|place|set|environment|interior|exterior)\b/i.test(known.role ?? "")) continue;
    return known.description.trim();
  }
  return undefined;
}

function findLocationBase(characters: string[] | undefined): string | undefined {
  for (const name of characters ?? []) {
    const known = lookupCharacter(name);
    if (!known) continue;
    if (!/\b(location|place|set|environment|interior|exterior)\b/i.test(known.role ?? "")) continue;
    const first = known.referenceImageUrls?.[0];
    if (first) return first;
  }
  return undefined;
}

/**
 * Beat ladder: the story shape a shot sequence follows, independent of length.
 * Positions are fractions through the film, so any shotCount scales sanely.
 */
export const BEAT_LADDER = [
  {
    at: 0.0,
    title: "Establishing",
    shotType: "wide",
    move: "slow dolly in",
    action: (scene: string) => `Establish the world: wide view of ${scene}, holding long enough for the audience to read the geography, the light sources, and the mood.`,
    note: "Orient the audience. Lock location, time of day, and key light direction; every later shot must match these.",
  },
  {
    at: 0.18,
    title: "Character Intro",
    shotType: "medium",
    move: "gentle push in",
    action: (scene: string, who: string) => `First clear look at ${who} inside ${scene}. Show what they are doing and what they want, in one readable action.`,
    note: "Match the establishing lighting. Introduce wardrobe and silhouette so continuity has a reference.",
  },
  {
    at: 0.4,
    title: "Rising Action",
    shotType: "tracking",
    move: "camera tracks alongside subject",
    action: (scene: string, who: string) => `${who} commits to a choice and moves deeper into ${scene}. Something changes in the environment to show rising pressure.`,
    note: "Keep wardrobe and props identical to the previous shot. Carry screen direction through the cut.",
  },
  {
    at: 0.62,
    title: "Complication",
    shotType: "close-up",
    move: "handheld drift",
    action: (scene: string, who: string) => `Tight on ${who} as the situation turns against them in ${scene}. Let the reaction carry the beat, not dialogue.`,
    note: "Tighten framing from the previous shot. Same lens character; keep the eyeline consistent.",
  },
  {
    at: 0.82,
    title: "Climax",
    shotType: "wide",
    move: "fast pull back",
    action: (scene: string, who: string) => `The tension peaks: ${who} faces the consequence in ${scene}, with the surroundings reacting around them.`,
    note: "Widen back out to re-establish the space. Match the mood and palette of the opening to close the visual loop.",
  },
  {
    at: 0.95,
    title: "Resolution",
    shotType: "medium",
    move: "slow pull out",
    action: (scene: string, who: string) => `${who} is left changed in ${scene}. Hold on the stillness a beat longer than feels comfortable.`,
    note: "Final shot. Return to the palette of the establishing shot and leave the frame on a clean held image.",
  },
];

type ShotBeat = {
  title: string;
  action: string;
  note?: string;
  framing?: string;
  shotType?: string;
  durationSeconds?: number;
  line?: { text?: string; delivery?: "spoken" | "sung" };
  faceAnchor?: "auto" | "off";
};

function planShots(opts: {
  sceneDescription: string;
  characterNames: string[];
  shotCount: number;
  totalDurationSeconds: number;
  /** Story beats supplied by the caller. Overrides the built-in ladder entirely. */
  beats?: ShotBeat[];
}) {
  const { sceneDescription, characterNames, shotCount, totalDurationSeconds, beats } = opts;

  // A supplied beat list wins. The built-in ladder is a template, and using it
  // when the user described their own story is how a film ends up following a
  // shape nobody asked for.
  if (beats && beats.length > 0) {
    const cast = characterNames.length > 0 ? characterNames : ["the main character"];
    const scene = sceneDescription.trim().replace(/\.$/, "");
    const per = Math.max(1, Math.floor(totalDurationSeconds / beats.length));
    return beats.map((beat, i) => ({
      shotNumber: i + 1,
      title: beat.title,
      shotType: resolveBeatShotType(beat, i),
      durationSeconds: resolveBeatDuration(beat, per),
      action: beat.action.replace(/\{scene\}/g, scene).replace(/\{character\}/g, cast[0]),
      ...(beat.faceAnchor ? { faceAnchor: beat.faceAnchor } : {}),
      continuityNotes: beat.note ?? "",
      characters: cast.filter(() => true),
      focusCharacter: cast[0],
      firstFrameFrom: i > 0 ? `last frame of shot ${i}` : undefined,
    }));
  }
  const scene = sceneDescription.trim().replace(/\.$/, "");
  const cast = characterNames.length > 0 ? characterNames : ["the main character"];

  // Tracks how many times each beat title has been used, so repeats get a suffix.
  const titleCounts = new Map<string, number>();

  // Even split with the remainder given to the earliest shots, so totals add up exactly.
  const base = Math.floor(totalDurationSeconds / shotCount);
  const remainder = totalDurationSeconds - base * shotCount;

  return Array.from({ length: shotCount }, (_, i) => {
    const position = shotCount === 1 ? 0 : i / (shotCount - 1);

    // Pick the beat whose ladder position is closest, without ever going backwards.
    let beat = BEAT_LADDER[0];
    for (const candidate of BEAT_LADDER) {
      if (candidate.at <= position + 1e-9) beat = candidate;
    }
    // For long sequences a beat repeats; number the repeats so titles stay distinct.
    const seen = titleCounts.get(beat.title) ?? 0;
    titleCounts.set(beat.title, seen + 1);
    const title = seen === 0 ? beat.title : `${beat.title} ${seen + 1}`;

    const focus = cast[i % cast.length];
    const shot: Record<string, unknown> = {
      index: i + 1,
      title,
      shotType: beat.shotType,
      cameraMove: beat.move,
      durationSeconds: base + (i < remainder ? 1 : 0),
      action: beat.action(scene, focus),
      continuityNotes: beat.note,
      characters: cast.filter(() => true),
      focusCharacter: focus,
    };

    // Attach real character context captured by create_character.
    const resolved = cast
      .map((name) => lookupCharacter(name))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (resolved.length > 0) {
      shot.characterContext = resolved.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        description: c.description,
        appearance: c.appearance,
        wardrobe: c.wardrobe,
        referenceImageUrls: c.referenceImageUrls ?? [],
      }));
    }

    if (i > 0) {
      shot.firstFrameFrom = `last frame of shot ${i}`;
      shot.continuityNotes = `${beat.note} Uses the last frame of shot ${i} as lastFrameUrl.`;
    }
    return shot;
  });
}

/**
 * Ask the user for the film configuration as a form, in one interaction.
 *
 * The point is cost. Each round trip is a model turn, and a model turn is
 * tokens; five conversational questions cost more than one form. So this tool
 * puts the whole brief on a single card and returns the answers as plain JSON
 * the caller can hand straight to plan_storyboard and generate_controlled_clip.
 *
 * Falls back to a text description of the same fields when the client has no
 * elicitation capability, so a caller is never worse off than before.
 */
/**
 * Turn the form answers into the sentence every shot prompt carries.
 *
 * Only fields the user actually filled in go in. A blank field stays blank: the
 * whole point of the form is that an unanswered question means "I don't care",
 * not "make something up".
 */
function buildContinuityBlock(v: Record<string, unknown>) {
  const parts: string[] = [];
  const style = String(v.style ?? "").trim();
  const characters = String(v.characters ?? "").trim();
  const audio = String(v.audio ?? "").trim();

  parts.push(`Maintain exactly across every shot: ${style ? `${style} look` : "the same look"}.`);
  if (characters) parts.push(`Cast, unchanged in every shot: ${characters}.`);
  if (audio) parts.push(`Audio: ${audio.toLowerCase()}.`);
  parts.push("Keep the same light source, palette and set dressing as the previous shot.");
  return parts.join(" ");
}

/** Constraints stay off the sent prompt. The lint and the checklist read this list. */
function storedNegativeFromBrief(v: Record<string, unknown>): string {
  const negatives: string[] = [];
  const never = String(v.neverShow ?? "").trim();
  if (never) negatives.push(never);
  negatives.push("no music");
  return negatives.join("\n");
}

const FILM_FORM_SCHEMA = {
  type: "object" as const,
  properties: {
    scene: {
      type: "string" as const,
      title: "Scene",
      description: "Location, time of day, weather, mood. One or two sentences.",
      minLength: 1,
      maxLength: 600,
      default: undefined as string | undefined,
    },
    characters: {
      type: "string" as const,
      title: "Characters",
      description:
        "For each: name, age, build, wardrobe, distinguishing features. " +
        "Anything you leave out is left out of the film, not invented.",
      maxLength: 600,
    },
    style: {
      type: "string" as const,
      title: "Style",
      description: "Look and colour direction.",
      enum: [
        "Photoreal cinematic",
        "Period film",
        "Documentary",
        "Animated",
        "Stylised illustration",
      ],
      default: "Photoreal cinematic",
    },
    shotCount: {
      type: "integer" as const,
      title: "Shots",
      description: "One paid render per shot.",
      minimum: 1,
      maximum: 8,
      default: 2,
    },
    shotSeconds: {
      type: "integer" as const,
      title: "Seconds per shot",
      description: "Each shot, 1 to 15 seconds.",
      minimum: 1,
      maximum: 15,
      default: 8,
    },
    resolution: {
      type: "string" as const,
      title: "Resolution and price",
      // The prices are the measured ones, per second of finished video, so the
      // choice is made on money rather than on a label. They live in the
      // option names because that is the only place a form shows them.
      enum: [
        "480p — $0.08/s, 8s shot $0.64",
        "720p — $0.14/s, 8s shot $1.12",
        "1080p — $0.25/s, 8s shot $2.00",
      ],
      default: "720p — $0.14/s, 8s shot $1.12",
    },
    aspectRatio: {
      type: "string" as const,
      title: "Shape",
      enum: ["16:9", "9:16", "1:1"],
      default: "16:9",
    },
    audio: {
      type: "string" as const,
      title: "Audio",
      enum: ["Diegetic only", "Dialogue", "Silent"],
      default: "Diegetic only",
    },
    neverShow: {
      type: "string" as const,
      title: "Never show",
      description: "Hard constraints, stated literally: no on-screen text, no logos, no extra people.",
      maxLength: 400,
    },
    audioTrack: {
      type: "string" as const,
      title: "Music or voiceover path (optional)",
      description:
        "Attach the track in chat and paste its path here, or use an https link. A track shorter " +
        "than the film is refused. A long enough track is faded out at the end. Leave blank for none.",
      maxLength: 500,
    },
    referenceImage: {
      type: "string" as const,
      title: "Reference image path (optional)",
      description:
        "A local path or https URL to a portrait or location still. Attach the file in chat " +
        "and paste its path here, or leave blank.",
      // Deliberately not format:"uri". That rejects a plain local path such as
      // /workspace/photo.png with "must match format uri", and a local path is
      // the normal case here because a chat attachment resolves to one.
    },
  },
  required: ["scene"],
};

server.registerTool(
  "configure_film",
  {
    description:
      "Collect the whole film brief as an interactive form in one turn: scene, characters, style, " +
      "shot count and length, aspect ratio, audio, hard constraints, and an optional reference " +
      "image. Cheaper than asking the same questions conversationally, because it costs one turn " +
      "instead of many. Returns the answers as JSON ready for plan_storyboard and " +
      "generate_controlled_clip, plus a cost estimate. It renders nothing and spends nothing.",
    inputSchema: z.object({
      scene: z.string().optional().describe("Pre-fill the scene if the user already said it."),
      prompt: z.string().optional().describe("Card heading shown to the user."),
    }),
  },
  async (args, extra) => {
    const title = args.prompt ?? "Configure the film";
    const mcp = currentMcpServer(server);
    const caps = mcp.server.getClientCapabilities();
    const scope = requestScope();
    const streamMissing = scope?.kind === "http" && !scope.sseConnected;
    const canElicit = Boolean(caps?.elicitation) && !streamMissing;

    const fields = Object.entries(FILM_FORM_SCHEMA.properties).map(([key, v]) => ({
      key,
      title: (v as { title?: string }).title ?? key,
      description: (v as { description?: string }).description ?? "",
    }));

    if (!canElicit) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            elicitationSupported: false,
            needsInput: true,
            message: streamMissing
              ? "This HTTP client has no server-to-client stream, so the form cannot be shown. " +
                "Ask for these fields conversationally in one message rather than one at a time."
              : "This client cannot show an interactive form, so ask for these fields conversationally " +
                "in one message rather than one at a time.",
            fields,
          }, null, 2),
        }],
      };
    }

    const schema = structuredClone(FILM_FORM_SCHEMA) as typeof FILM_FORM_SCHEMA;
    if (args.scene) schema.properties.scene = { ...schema.properties.scene, default: args.scene };

    let result;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const elicitation = mcp.server.elicitInput({
        message: title,
        requestedSchema: schema,
      } as Parameters<typeof mcp.server.elicitInput>[0]);
      // Desktop stdio waits for the form. The timeout is only for HTTP, where a
      // client can advertise elicitation and then never answer.
      if (scope?.kind !== "http") {
        result = await elicitation;
      } else {
        const timer = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("elicitation timed out")), elicitTimeoutMs());
          extra?.signal?.addEventListener("abort", () => {
            reject(new Error("elicitation aborted"));
          }, { once: true });
        });
        result = await Promise.race([elicitation, timer]);
      }
    } catch (err) {
      const timedOut = err instanceof Error && err.message === "elicitation timed out";
      if (timedOut) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              elicitationSupported: false,
              needsInput: true,
              message:
                "The form was not answered in time. Ask for these fields conversationally " +
                "in one message rather than one at a time.",
              fields,
            }, null, 2),
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            elicitationSupported: true,
            formFailed: true,
            error: err instanceof Error ? err.message : String(err),
            message: "The form was shown but the response was rejected. Ask for the same fields conversationally.",
          }, null, 2),
        }],
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (result.action !== "accept") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: result.action,
            message:
              result.action === "decline"
                ? "The user dismissed the form. Do not render. Ask what they would like to change."
                : "The user cancelled. Do not render.",
          }, null, 2),
        }],
      };
    }

    const v = (result.content ?? {}) as Record<string, unknown>;
    const shotCount = Number(v.shotCount ?? 2);
    const shotSeconds = Number(v.shotSeconds ?? 8);
    // The form asks for resolution now, so the estimate can use the rate the
    // user actually picked. It used to hardcode 720p because the form could not
    // know, which meant the number shown was not the number they would be
    // charged whenever they wanted something other than 720p.
    const resolution = resolutionFromLabel(v.resolution) ?? "720p";
    const perShot = Math.round(shotSeconds * ratePerSecond(resolution) * 100) / 100;
    const total = Math.round(perShot * shotCount * 100) / 100;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "accept",
          config: {
            scene: v.scene ?? "",
            characters: v.characters ?? "",
            style: v.style ?? "Photoreal cinematic",
            shotCount,
            shotSeconds,
            resolution,
            aspectRatio: v.aspectRatio ?? "16:9",
            audio: v.audio ?? "Diegetic only",
            neverShow: v.neverShow ?? "",
            referenceImage: v.referenceImage || undefined,
            audioTrack: v.audioTrack || undefined,
          },
          estimate: {
            perShotUsd: perShot,
            totalUsd: total,
            basis:
              `${shotCount} renders x ${shotSeconds}s at $${ratePerSecond(resolution).toFixed(2)}/s ` +
              `for ${resolution} = $${total.toFixed(2)}.`,
            isEstimate: true,
          },
          continuityBlock: buildContinuityBlock(v),
          negative: storedNegativeFromBrief(v),
          contract: {
            sentContinuity: buildContinuityBlock(v),
            negativeStored: storedNegativeFromBrief(v),
            lintHits: lintSentPrompt(buildContinuityBlock(v), storedNegativeFromBrief(v)),
            resolution,
            shotSeconds,
            quote: {
              perShotUsd: perShot,
              totalUsd: total,
              ratePerSecond: ratePerSecond(resolution),
            },
          },
          next:
            "Show the sent continuity, the stored negative, any lint hits, and the quote. " +
            "Then call plan_storyboard, and create_character with referenceImageUrls if a " +
            "reference image was given. Pass continuityBlock as render_sequence's `continuity` " +
            "and negative as the stored constraints. Pass audioTrack as `audioTrackUrl`. " +
            "Never invent a character detail the user left blank.",
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "create_character",
  {
    description: "Create or update a character with optional reference images for continuity.",
    inputSchema: CharacterSchema,
  },
  async (args) => {
    let stored: Awaited<ReturnType<typeof rememberCharacter>>;
    try {
      stored = await rememberCharacter(args);
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: err instanceof Error ? err.message : "Could not save the character.",
          }, null, 2),
        }],
        isError: true,
      };
    }

    const { entry, folder, warnings } = stored;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...entry,
          storage: folder,
          referenceImages: (entry.referenceImageUrls ?? []).length,
          ...(warnings ? { warnings } : {}),
          message:
            `Character saved on disk in ${folder}. It survives a restart, so you can reuse it by ` +
            "name in any later session without supplying the reference images again. " +
            "plan_storyboard can now use it for continuity." +
            (warnings ? " Some reference images could not be kept; see warnings." : ""),
        }, null, 2)
      }]
    };
  }
);

function stampShotNumbers<T extends { shot?: number }>(events: T[] | undefined, shot: number): T[] {
  return (events ?? []).map((event) => ({ ...event, shot: event.shot ?? shot }));
}

/** Ledger events persisted or checked as a plan always carry a shot number. */
function eventsWithShot<T extends { shot?: number }>(
  events: readonly T[] | undefined,
): Array<T & { shot: number }> {
  return (events ?? []).map((event) => ({ ...event, shot: event.shot ?? 1 }));
}

function buildContinuityLedger(input: {
  characterNames: string[];
  shotCount: number;
  shotLocations?: Array<string | undefined>;
  locations?: LocationRecord[];
  props?: PropRecord[];
  wardrobeEvents?: WardrobeEvent[];
  propEvents?: PropEvent[];
  shotSteps?: Array<{ shot: number; steps: string[] }>;
}) {
  const characters = input.characterNames
    .map((name) => lookupCharacter(name))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => characterFromRecord(entry));
  const hasReferencePicture = input.characterNames.some((name) => {
    const known = lookupCharacter(name);
    return Boolean(known?.referenceImageUrls && known.referenceImageUrls.length > 0);
  });
  const plan = {
    characters,
    locations: input.locations,
    props: input.props,
    wardrobeEvents: input.wardrobeEvents,
    propEvents: input.propEvents,
    shotLocations: input.shotLocations,
    shotCount: input.shotCount,
    hasReferencePicture,
    ...(input.shotSteps && input.shotSteps.length > 0 ? { shotSteps: input.shotSteps } : {}),
  };
  const snapshots = replayContinuity(plan);
  const contracts = deriveContracts(plan);
  return {
    characters,
    hasReferencePicture,
    snapshots: snapshots.map((shot, index) => ({
      ...shot,
      contractPrompt: contracts[index] ? promptFromContract(contracts[index]) : undefined,
    })),
    contracts,
    plan,
  };
}

function continuityPlanFromRenderArgs(args: {
  shots: Array<{ locationId?: string; prompt?: string }>;
  characters?: string[];
  promptStyle?: "legacy" | "sections-v2";
  ledger?: {
    locations?: LocationRecord[];
    props?: PropRecord[];
    wardrobeEvents?: Array<Omit<WardrobeEvent, "shot"> & { shot?: number }>;
    propEvents?: Array<Omit<PropEvent, "shot"> & { shot?: number }>;
    shotSteps?: Array<{ shot: number; steps: string[] }>;
    voiceId?: string;
    promptStyle?: "legacy" | "sections-v2";
    spokenLines?: ContinuityPlan["spokenLines"];
    shotPrompts?: ContinuityPlan["shotPrompts"];
    scaleMarks?: ContinuityPlan["scaleMarks"];
    bodyClearance?: ContinuityPlan["bodyClearance"];
    humanVisionSignOff?: boolean;
    tier1?: ContinuityPlan["tier1"];
    hasPortrait?: boolean;
  } | null;
}): ContinuityPlan | undefined {
  if (!args.ledger) return undefined;
  const characterNames = args.characters ?? [];
  const characters = characterNames
    .map((name) => lookupCharacter(name))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => characterFromRecord(entry));
  const hasReferencePicture = characterNames.some((name) => {
    const known = lookupCharacter(name);
    return Boolean(known?.referenceImageUrls && known.referenceImageUrls.length > 0);
  });
  const shotPrompts = args.ledger.shotPrompts ?? args.shots
    .map((shot, index) => ({ shot: index + 1, prompt: shot.prompt ?? "" }))
    .filter((entry) => entry.prompt.trim().length > 0);
  return {
    characters,
    locations: args.ledger.locations,
    props: args.ledger.props,
    wardrobeEvents: eventsWithShot(args.ledger.wardrobeEvents),
    propEvents: eventsWithShot(args.ledger.propEvents),
    shotLocations: args.shots.map((shot) => shot.locationId),
    shotCount: args.shots.length,
    shotSteps: args.ledger.shotSteps,
    hasReferencePicture: hasReferencePicture || Boolean(args.ledger.hasPortrait),
    hasPortrait: args.ledger.hasPortrait ?? hasReferencePicture,
    ...(args.ledger.voiceId ? { voiceId: args.ledger.voiceId } : {}),
    ...((args.promptStyle ?? args.ledger.promptStyle)
      ? { promptStyle: args.promptStyle ?? args.ledger.promptStyle }
      : {}),
    ...(args.ledger.spokenLines ? { spokenLines: args.ledger.spokenLines } : {}),
    ...(shotPrompts.length > 0 ? { shotPrompts } : {}),
    ...(args.ledger.scaleMarks ? { scaleMarks: args.ledger.scaleMarks } : {}),
    ...(args.ledger.bodyClearance ? { bodyClearance: args.ledger.bodyClearance } : {}),
    ...(args.ledger.humanVisionSignOff ? { humanVisionSignOff: true } : {}),
    ...(args.ledger.tier1 ? { tier1: args.ledger.tier1 } : {}),
  };
}

function refusal(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Text stays the historical JSON. structuredContent is that same JSON, with no outputSchema. */
function structuredText(payload: Record<string, unknown>) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

const costApprovalFields = {
  approvedUsd: z.number().optional().describe(
    "Usd from the estimate being approved. If it does not match this call's estimate, the confirm is refused. Omit to keep the previous confirm behavior.",
  ),
  approvedKind: z.enum(["board", "video", "still", "extend", "retry"]).optional().describe(
    "Which quote this confirm is for. A board approval does not authorize video, and a video approval does not authorize a board.",
  ),
  approvedFingerprint: z.string().optional().describe(
    "Fingerprint of the approved estimate. It covers the prompts, frames, resolution, duration, shot count, and pin. A change invalidates the confirm.",
  ),
  budgetUsd: z.number().min(0).optional().describe(
    "Cumulative film budget. Crossing it adds a warning. It never authorizes spending and never stops a render that was already approved.",
  ),
};

type CostArgs = {
  confirm: boolean;
  approvedUsd?: number;
  approvedKind?: SpendKind;
  approvedFingerprint?: string;
  overrideValidation?: boolean;
  budgetUsd?: number;
};

async function quoteGate(
  args: CostArgs,
  kind: SpendKind,
  usd: number,
  fingerprint: string,
  job?: SequenceJob,
): Promise<PaidAction> {
  const queued = job ? await readQueuedFilmSpend(job.id, job.spendLedger?.appliedNoteIds) : undefined;
  const spentUsd = Math.round(((job ? recordedSpendUsd(job) : 0) + (queued?.pendingSpendUsd ?? 0)) * 100) / 100;
  return gatePaidAction({
    kind,
    usd,
    fingerprint,
    confirm: args.confirm,
    approvedUsd: args.approvedUsd,
    approvedKind: args.approvedKind,
    approvedFingerprint: args.approvedFingerprint,
    overrideValidation: args.overrideValidation,
    spentUsd,
    budgetUsd: args.budgetUsd ?? queued?.pendingThresholdUsd,
  });
}

function costRefusal(paid: PaidAction | undefined, extra?: Record<string, unknown>) {
  if (!paid || paid.decision !== "refused") return undefined;
  return refusal({
    action: "refused",
    willRender: false,
    willSpend: false,
    reason: paid.reason,
    message: paid.reason,
    costQuote: paid.quote,
    ...(paid.budgetWarning ? { budgetWarning: paid.budgetWarning } : {}),
    ...extra,
  });
}

function withCost(
  result: { content: Array<{ type: "text"; text: string }> },
  paid: PaidAction,
) {
  const text = result.content[0]?.text ?? "{}";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { message: text };
  }
  return refusal({ ...body, ...costFields(paid) });
}

function costFields(paid: PaidAction | undefined): Record<string, unknown> {
  if (!paid) return {};
  return {
    costQuote: paid.quote,
    ...(paid.budgetWarning ? { budgetWarning: paid.budgetWarning } : {}),
    ...(paid.unboundApproval ? { unboundApproval: paid.unboundApproval } : {}),
  };
}

export function recordedSpendUsd(job: {
  shots: Array<{ costUsd?: number }>;
  spendLedger?: PersistedSpend;
}): number {
  const entries = job.spendLedger?.entries ?? [];
  if (entries.length > 0) {
    return Math.round(entries.reduce((sum, entry) => sum + entry.usd, 0) * 100) / 100;
  }
  return Math.round(job.shots.reduce((sum, shot) => sum + (shot.costUsd ?? 0), 0) * 100) / 100;
}

export function noteReportedSpend(
  job: SequenceJob,
  kind: SpendKind,
  usd: number,
  flags?: { estimated?: boolean; derived?: boolean; uncertain?: boolean; reason?: string },
): void {
  const unbilled = flags?.reason !== undefined && !(usd > 0);
  if (!(usd > 0) && !unbilled) return;
  const entries = [...(job.spendLedger?.entries ?? [])];
  if (entries.length === 0) {
    for (const shot of job.shots) {
      if ((shot.costUsd ?? 0) > 0) {
        entries.push({ kind: "video", usd: shot.costUsd ?? 0, derived: true });
      }
    }
  }
  entries.push({
    kind,
    usd: Math.round(usd * 100) / 100,
    ...(flags?.estimated ? { estimated: true } : {}),
    ...(flags?.derived ? { derived: true } : {}),
    ...(flags?.uncertain ? { uncertain: true } : {}),
    ...(flags?.reason ? { reason: flags.reason } : {}),
  });
  const spentUsd = Math.round(entries.reduce((sum, entry) => sum + entry.usd, 0) * 100) / 100;
  const appliedNoteIds = job.spendLedger?.appliedNoteIds;
  job.spendLedger = {
    version: 1,
    spentUsd,
    pendingUsd: 0,
    ...(job.spendLedger?.thresholdUsd !== undefined ? { thresholdUsd: job.spendLedger.thresholdUsd } : {}),
    ...(appliedNoteIds ? { appliedNoteIds } : {}),
    entries,
  };
}

/** Keep a film's recorded spend. A pre-ledger film is derived from its shot costs. */
export function carrySpend(source: SequenceJob): PersistedSpend | undefined {
  if (source.spendLedger?.entries && source.spendLedger.entries.length > 0) {
    return structuredClone(source.spendLedger);
  }
  const derived = source.shots.flatMap((shot) => (
    (shot.costUsd ?? 0) > 0
      ? [{ kind: "video" as const, usd: Math.round((shot.costUsd ?? 0) * 100) / 100, derived: true }]
      : []
  ));
  if (derived.length === 0) {
    return source.spendLedger ? structuredClone(source.spendLedger) : undefined;
  }
  const spentUsd = Math.round(derived.reduce((sum, entry) => sum + entry.usd, 0) * 100) / 100;
  return {
    version: 1,
    spentUsd,
    pendingUsd: 0,
    ...(source.spendLedger?.thresholdUsd !== undefined ? { thresholdUsd: source.spendLedger.thresholdUsd } : {}),
    ...(source.spendLedger?.appliedNoteIds ? { appliedNoteIds: [...source.spendLedger.appliedNoteIds] } : {}),
    entries: derived,
  };
}

export type NoteOutcome = { applied: true } | { applied: false; deferred: true; queued: true; reason: string };

function queuedFields(queued: QueuedFilmSpend | undefined): Record<string, unknown> {
  if (!queued) return {};
  return {
    ...(queued.pendingSpendUsd > 0 ? { pendingSpendUsd: queued.pendingSpendUsd } : {}),
    ...(queued.pendingThresholdUsd !== undefined ? { pendingThresholdUsd: queued.pendingThresholdUsd } : {}),
  };
}

function applySpendNote(job: SequenceJob, note: SpendNote): void {
  if (note.op === "budget") {
    const spent = job.spendLedger?.entries?.length ? job.spendLedger.spentUsd : recordedSpendUsd(job);
    job.spendLedger = {
      ...(job.spendLedger ?? { version: 1, spentUsd: spent, pendingUsd: 0 }),
      thresholdUsd: note.thresholdUsd,
      spentUsd: spent,
    };
    return;
  }
  noteReportedSpend(job, note.kind, note.usd, {
    estimated: note.estimated,
    uncertain: note.uncertain,
    reason: note.reason,
  });
}

function rememberAppliedNote(job: SequenceJob, id: string): void {
  const ids = job.spendLedger?.appliedNoteIds ?? [];
  if (ids.includes(id)) return;
  const spent = job.spendLedger?.spentUsd ?? recordedSpendUsd(job);
  job.spendLedger = {
    version: 1,
    spentUsd: spent,
    pendingUsd: job.spendLedger?.pendingUsd ?? 0,
    ...(job.spendLedger?.thresholdUsd !== undefined ? { thresholdUsd: job.spendLedger.thresholdUsd } : {}),
    ...(job.spendLedger?.entries ? { entries: job.spendLedger.entries } : {}),
    appliedNoteIds: [...ids, id],
  };
}

export async function enqueueSpendNote(jobId: string, note: SpendNoteInput): Promise<void> {
  const full: SpendNote = { ...note, id: randomUUID() };
  const dir = spendJournalDir(jobId);
  await mkdir(dir, { recursive: true });
  const finalName = `${String(Date.now()).padStart(16, "0")}-${full.id}.json`;
  const dest = join(dir, finalName);
  const tmp = join(dir, `.${finalName}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(full));
  await rename(tmp, dest);
}

let beforeJournalMerge: (() => Promise<void>) | undefined;
let beforeJournalDelete: (() => Promise<void>) | undefined;

export function setJournalProbes(next: {
  beforeMerge?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;
} | undefined): void {
  beforeJournalMerge = next?.beforeMerge;
  beforeJournalDelete = next?.beforeDelete;
}

/** Apply notes that are not already in the ledger. The files stay until the job rename succeeds. */
async function applyQueuedNotes(job: SequenceJob): Promise<string[]> {
  const { valid, torn } = await listJournal(job.id);
  for (const file of torn) await unlink(file).catch(() => undefined);
  const applied = new Set(job.spendLedger?.appliedNoteIds ?? []);
  const consumed: string[] = [];
  for (const { file, note } of valid) {
    if (!applied.has(note.id)) {
      applySpendNote(job, note);
      rememberAppliedNote(job, note.id);
      applied.add(note.id);
    }
    consumed.push(file);
  }
  return consumed;
}

function thisProcessOwns(job: SequenceJob): boolean {
  const owner = job.owner;
  if (owner && owner.token === processToken && owner.pid === process.pid) return true;
  const claim = job.claim;
  return Boolean(claim && claim.token === processToken && claim.pid === process.pid);
}

function deferredField(outcome: NoteOutcome | undefined, key: "budgetNote" | "spendNote"): Record<string, unknown> {
  if (!outcome || outcome.applied) return {};
  return { [key]: { deferred: true, queued: true, reason: outcome.reason } };
}

/** What to record after a provider call. A refusal is $0. A missing bill on an accepted call is the quote. */
export function chargeForProviderResult(
  result: {
    status?: string;
    costUsd?: number;
    code?: string;
    fallback?: string;
    requestId?: string;
    error?: string;
    videoUrl?: string;
    localPath?: string;
    imageUrl?: string;
  },
  quotedUsd: number,
): { record: boolean; usd: number; estimated?: boolean; uncertain?: boolean; reason?: string } {
  if (
    result.fallback === "stub"
    || result.code === "no-credential"
    || result.code === "expired-credential"
    || result.code === "prompt-rejected"
  ) {
    return { record: false, usd: 0 };
  }
  const reported = result.costUsd ?? 0;
  if (reported > 0) return { record: true, usd: Math.round(reported * 100) / 100 };
  const accepted = result.status === "completed"
    || result.status === "submitted"
    || Boolean(result.requestId)
    || Boolean(result.videoUrl)
    || Boolean(result.localPath)
    || Boolean(result.imageUrl);
  if (accepted) return { record: true, usd: quotedUsd, estimated: true };
  if (result.status === "timeout" || result.code === "timeout") {
    return {
      record: true,
      usd: quotedUsd,
      estimated: true,
      uncertain: true,
      reason: result.error ?? "The provider did not say whether this was billed.",
    };
  }
  if (
    result.code === "rejected"
    || result.code === "failed"
    || result.code === "submit-failed"
    || result.code === "no-request-id"
    || result.status === "failed"
  ) {
    return {
      record: true,
      usd: 0,
      reason: result.error ?? result.code ?? "The provider did not accept this request.",
    };
  }
  return {
    record: true,
    usd: 0,
    uncertain: true,
    reason: result.error ?? "The provider did not say whether this was billed.",
  };
}

async function writeFilmNote(jobId: string, note: SpendNoteInput, patch: (job: SequenceJob) => void): Promise<NoteOutcome> {
  let reason = "The note was not written.";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const saved = await saveJobAnnotation(jobId, patch);
    if (saved.ok) return { applied: true };
    reason = saved.message;
    if (!saved.message.includes("retry shortly")) break;
    await sleep(5 + attempt);
  }
  await enqueueSpendNote(jobId, note);
  return { applied: false, deferred: true, queued: true, reason };
}

async function rememberBudget(jobId: string, budgetUsd: number): Promise<NoteOutcome> {
  return writeFilmNote(jobId, { op: "budget", thresholdUsd: budgetUsd }, (job) => {
    const spent = job.spendLedger?.entries?.length ? job.spendLedger.spentUsd : recordedSpendUsd(job);
    job.spendLedger = {
      ...(job.spendLedger ?? { version: 1, spentUsd: spent, pendingUsd: 0 }),
      thresholdUsd: budgetUsd,
      spentUsd: spent,
    };
  });
}

async function recordFilmCost(
  jobId: string,
  kind: SpendKind,
  usd: number,
  flags?: { estimated?: boolean; uncertain?: boolean; reason?: string },
): Promise<NoteOutcome> {
  return writeFilmNote(jobId, {
    op: "spend",
    kind,
    usd,
    estimated: flags?.estimated,
    uncertain: flags?.uncertain,
    reason: flags?.reason,
  }, (job) => {
    noteReportedSpend(job, kind, usd, flags);
  });
}

async function refuseIfSessionWillNotLast(estimatedJobMs: number) {
  if (paidStubEnabled()) return undefined;
  const session = await ensureCredentialForJob(estimatedJobMs);
  if (session.ok) return undefined;
  return refusal({
    action: "refused",
    error: session.reason,
    code: session.code === "expired" ? "session-too-short" : session.code,
  });
}

function applyShotContinuity(
  shot: Record<string, unknown>,
  snapshot: ShotContinuity | undefined,
  wardrobeChanged: boolean,
  appendProse = true,
) {
  if (!snapshot) return shot;
  shot.locationId = snapshot.locationId;
  shot.wardrobeChecklist = snapshot.checklists;
  shot.propsInView = snapshot.propsInView;
  shot.continuityPrompt = snapshot.prompt;
  shot.wardrobeChanged = wardrobeChanged;
  if (!appendProse) {
    if (snapshot.warnings.length > 0) shot.continuityWarnings = snapshot.warnings;
    return shot;
  }
  const extras = [snapshot.prompt, snapshot.contractPrompt].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  if (extras.length > 0) {
    const extra = extras.join(" ");
    if (typeof shot.action === "string") {
      shot.action = annotateAction(shot.action, extra);
    }
    if (typeof shot.prompt === "string") {
      shot.prompt = annotateAction(shot.prompt, extra);
    }
    const notes = typeof shot.continuityNotes === "string" ? shot.continuityNotes : "";
    shot.continuityNotes = [notes, extra].filter((part) => part.trim()).join(" ");
  }
  if (snapshot.warnings.length > 0) shot.continuityWarnings = snapshot.warnings;
  return shot;
}

server.registerTool(
  "plan_storyboard",
  {
    description:
      "Plan multi-shot storyboard for a scene. Accepts optional wardrobe events and a " +
      "per-location prop ledger so each shot's prompt describes only what is worn and " +
      "the props that belong in that room.",
    inputSchema: z.object({
      sceneDescription: z.string(),
      promptStyle: z.enum(["legacy", "sections-v2"]).optional().describe(
        "Omit it, or pass legacy, for today's paragraph. sections-v2 writes a sectioned prompt " +
        "on each shot and does not append the ledger paragraph.",
      ),
      voiceId: z.string().optional().describe(
        "Built-in voice, such as rex. In sections-v2 the spoken line is tagged <AUDIO_0>.",
      ),
      fixedSet: z.string().optional().describe(
        "One sentence naming the fixed pieces and their sizes, used by sections-v2.",
      ),
      marks: z.record(z.string(), z.string()).optional().describe(
        "Named standing positions. A beat's start.mark or end.mark looks up the sentence here.",
      ),
      beats: z.array(z.object({
        title: z.string(),
        action: z.string().describe("What happens in this shot. {scene} and {character} are substituted."),
        note: z.string().optional().describe("Continuity requirement carried into the prompt."),
        locationId: z.string().optional().describe("Room this shot takes place in. Props are scoped to it."),
        wardrobeEvents: z.array(WardrobeEventSchema).optional(),
        propEvents: z.array(PropEventSchema).optional(),
        framing: z.enum(["wide", "medium", "close", "feet-close"]).optional(),
        shotType: z.string().optional(),
        camera: z.enum(["locked"]).optional(),
        durationSeconds: z.number().min(1).max(15).optional(),
        faceAnchor: z.enum(["auto", "off"]).optional(),
        steps: z.array(z.string()).optional(),
        line: z.object({
          text: z.string(),
          delivery: z.enum(["spoken", "sung"]).optional(),
          voiceTag: z.string().optional(),
        }).optional(),
        contact: z.string().optional(),
        avoid: z.array(z.string()).optional(),
        audio: z.string().optional(),
        start: z.object({
          worn: z.array(z.string()).optional(),
          mark: z.string().optional(),
          text: z.string().optional(),
          door: z.string().optional(),
          slots: z.record(z.string(), z.string().nullable()).optional(),
          floorAt: z.array(z.object({
            item: z.string().optional(),
            n: z.number().optional(),
            text: z.string(),
          })).optional(),
        }).optional(),
        end: z.object({
          worn: z.array(z.string()).optional(),
          mark: z.string().optional(),
          text: z.string().optional(),
          held: z.string().optional(),
          door: z.string().optional(),
          slots: z.record(z.string(), z.string().nullable()).optional(),
        }).optional(),
      })).optional().describe(
        "Your own story beats, one per shot. Overrides the built-in six-beat ladder, which is only " +
        "a default shape and must not be imposed on a story the user already described.",
      ),
      characters: z.array(z.string()),
      targetDurationSeconds: z.number().optional(),
      shotCount: z.number().optional(),
      locations: z.array(LocationSchema).optional().describe(
        "Named rooms. Two props with the same name in different rooms stay two props.",
      ),
      props: z.array(PropRecordSchema).optional().describe(
        "Starting prop ledger. Each prop belongs to one locationId.",
      ),
      wardrobeEvents: z.array(WardrobeEventSchema).optional().describe(
        "Named clothing changes, keyed by 1-based shot number: remove, putOn, adjust.",
      ),
      propEvents: z.array(PropEventSchema).optional().describe(
        "Named prop changes, keyed by 1-based shot number: add, move, remove. A prop without " +
        "an id is left where it is.",
      ),
    }),
  },
  async (args) => {
    // Honour shotCount, but keep it inside a sane range for a shootable sequence.
    const requested = args.shotCount ?? Math.max(1, Math.round((args.targetDurationSeconds ?? 16) / 8));
    const shotCount = Math.min(12, Math.max(1, Math.round(requested)));
    const totalDurationSeconds = Math.min(
      180,
      Math.max(shotCount, Math.round(args.targetDurationSeconds ?? shotCount * 8)),
    );

    const shots = planShots({
      sceneDescription: args.sceneDescription,
      characterNames: args.characters ?? [],
      shotCount,
      totalDurationSeconds,
      beats: args.beats,
    });
    if (args.promptStyle === "sections-v2") {
      const layers = (args.characters ?? []).flatMap((name) => {
        const known = lookupCharacter(name);
        return known?.wardrobe?.layers ?? [];
      });
      for (let index = 0; index < shots.length; index += 1) {
        const beat = args.beats?.[index];
        if (!beat) continue;
        const shot = shots[index] as Record<string, unknown>;
        shot.prompt = renderSectionsV2(beat, {
          layers,
          marks: args.marks,
          fixedSet: args.fixedSet,
          voiceId: args.voiceId,
        });
        if (beat.faceAnchor) shot.faceAnchor = beat.faceAnchor;
      }
    }

    const shotLocations = (args.beats ?? []).map((beat) => beat.locationId);
    const beatWardrobe = (args.beats ?? []).flatMap((beat, index) =>
      stampShotNumbers(beat.wardrobeEvents, index + 1),
    );
    const beatProps = (args.beats ?? []).flatMap((beat, index) =>
      stampShotNumbers(beat.propEvents, index + 1),
    );
    const wardrobeEvents = [
      ...stampShotNumbers(args.wardrobeEvents, 1).map((event, index) => ({
        ...event,
        shot: args.wardrobeEvents?.[index]?.shot ?? event.shot,
      })),
      ...beatWardrobe,
    ].filter((event): event is WardrobeEvent => typeof event.shot === "number");
    const propEvents = [
      ...stampShotNumbers(args.propEvents, 1).map((event, index) => ({
        ...event,
        shot: args.propEvents?.[index]?.shot ?? event.shot,
      })),
      ...beatProps,
    ].filter((event): event is PropEvent => typeof event.shot === "number");

    const { snapshots } = buildContinuityLedger({
      characterNames: args.characters ?? [],
      shotCount: shots.length,
      shotLocations: shotLocations.length === shots.length ? shotLocations : shotLocations.concat(
        Array.from({ length: Math.max(0, shots.length - shotLocations.length) }, () => undefined),
      ),
      locations: args.locations,
      props: args.props,
      wardrobeEvents,
      propEvents,
      shotSteps: (args.beats ?? []).flatMap((beat, index) =>
        beat.steps && beat.steps.length > 0 ? [{ shot: index + 1, steps: beat.steps }] : [],
      ),
    });

    const annotated = shots.map((shot, index) =>
      applyShotContinuity(
        { ...shot } as Record<string, unknown>,
        snapshots[index],
        wardrobeEvents.some((event) => event.shot === index + 1),
        // A sectioned beat already carries the wardrobe. A sections-v2 call with
        // no beat for this shot still needs the ledger paragraph.
        args.promptStyle !== "sections-v2" || !args.beats?.[index],
      ),
    );
    const continuityWarnings = snapshots.flatMap((snapshot) => snapshot.warnings);

    const unknown = (args.characters ?? []).filter((name) => !lookupCharacter(name));
    const payload: Record<string, unknown> = {
      scene: args.sceneDescription,
      shotCount: annotated.length,
      totalDurationSeconds: annotated.reduce((sum, shot) => sum + (shot.durationSeconds as number), 0),
      shots: annotated,
      continuity: {
        locations: args.locations ?? [],
        props: args.props ?? [],
        wardrobeEvents,
        propEvents,
        shots: snapshots,
        ...(args.promptStyle ? { promptStyle: args.promptStyle } : {}),
        ...(args.voiceId ? { voiceId: args.voiceId } : {}),
      },
    };
    if (continuityWarnings.length > 0) payload.continuityWarnings = continuityWarnings;
    if (unknown.length > 0) {
      payload.note = `No stored character record for: ${unknown.join(", ")}. Call create_character first so continuity notes can carry wardrobe and reference images.`;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    };
  }
);

/**
 * Build the prompt actually sent for a shot.
 *
 * The renderer has no memory between calls, so anything that has to stay the
 * same across the film has to be in every single prompt. Relying on the model
 * to copy wardrobe and set details forward is how half a film ends up with the
 * wrong coat. `continuity` is written once and prepended here.
 */
/**
 * Does this shot put a person in frame?
 *
 * Only worth asking because the face anchor costs a little and is not free to
 * misapply: adding a face instruction to a shot with no face in it gives the
 * model a reason to invent one. A shot that says "close on his hands" still
 * wants the anchor — his hands belong to him — so hands, arms and body parts
 * count alongside the obvious wording.
 */
function mentionsPerson(prompt: string) {
  return shouldAnchorFace(prompt);
}

function composeShotPrompt(continuity: string | undefined, prompt: string) {
  const anchor = continuity?.trim();
  const shot = prompt.trim();
  if (!anchor) return shot;
  return `${anchor}

Shot: ${shot}`;
}

function sentShotPrompt(
  continuity: string | undefined,
  shot: { prompt?: string; faceAnchor?: "auto" | "off"; shotType?: string },
) {
  const prompt = composeShotPrompt(continuity, shot.prompt ?? "");
  return mentionsPerson(prompt) && shouldAnchorFace(prompt, {
    faceAnchor: shot.faceAnchor,
    shotType: shot.shotType,
  })
    ? `${prompt} Keep the face exactly as the first frame shows it.`
    : prompt;
}

function sequenceContractShots(input: {
  shots: Array<{
    prompt?: string;
    title?: string;
    durationSeconds?: number;
    firstFrameUrl?: string;
    lastFrameUrl?: string;
    referenceImageUrls?: string[];
    negative?: string;
    faceAnchor?: "auto" | "off";
    shotType?: string;
  }>;
  continuity?: string;
  resolution: string;
  pin: "start" | "end" | "both";
  voiceId?: string;
}) {
  return input.shots.map((shot, index) => {
    const sentPrompt = sentShotPrompt(input.continuity, shot);
    const lintHits = lintSentPrompt(sentPrompt, shot.negative);
    const seconds = Number(shot.durationSeconds) || 8;
    const rate = ratePerSecond(input.resolution);
    const totalUsd = Math.round(seconds * rate * 100) / 100;
    const startFrame = shot.firstFrameUrl
      ? shot.firstFrameUrl
      : index > 0
        ? "previous shot's last frame, pinned after that shot renders"
        : null;
    return {
      index: index + 1,
      title: shot.title ?? `Shot ${index + 1}`,
      sentPrompt,
      lintHits,
      resolution: input.resolution,
      durationSeconds: seconds,
      pin: input.pin,
      startFrame,
      closingFrameSent: input.pin === "both" && Boolean(shot.lastFrameUrl),
      referenceImageUrls: shot.referenceImageUrls ?? [],
      voiceId: input.voiceId ?? null,
      negativeStored: shot.negative ?? "",
      quote: {
        totalUsd,
        ratePerSecond: rate,
        basis: `${seconds}s at $${rate.toFixed(2)}/s for ${input.resolution} = $${totalUsd.toFixed(2)}.`,
      },
    };
  });
}

/**
 * A local path for an image reference, or undefined when it is remote or
 * already inlined. Used to record where a pinned frame lives on this machine, so
 * a resume or a repair can point at the same file the board produced.
 */
function localImagePath(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return undefined;
  return trimmed.startsWith("file://") ? new URL(trimmed).pathname : trimmed;
}

type VideoJob = {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  model?: string;
  referenceImageUrls?: string[];
  firstFrameUrl?: string;
  /** Pinned final frame. Sent only when pin is "both" (or unset, for older callers). */
  lastFrameUrl?: string;
  pin?: "start" | "both";
  voiceId?: string;
  resolution?: string;
  negative?: string;
  admission?: TakeReport;
};

/** Uniform shape so callers can read optional fields without narrowing gymnastics. */
type ClipResult = Omit<GrokClipResult, "status"> & { status?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelledBeforeSpend(extra?: { signal?: AbortSignal }) {
  if (!extra?.signal?.aborted) return undefined;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ action: "cancelled", willRender: false }),
    }],
  };
}


server.registerTool(
  "generate_controlled_clip",
  {
    description:
      "Generate a single video clip with reference images and optional first-frame continuity. " +
      "Uses a real Grok Imagine Video backend, authenticating with XAI_API_KEY when present or " +
      "falling back to the Grok CLI session in ~/.grok/auth.json so calls bill to the Grok subscription. " +
      "Spends only after confirm, and only when the continuity gate passes. Pin defaults to the " +
      "start frame: an end-frame pin holds the pose and has to be asked for.",
    inputSchema: z.object({
      prompt: z.string(),
      characters: z.array(z.string()).optional().describe(
        "Names of characters created with create_character. Their reference images are merged " +
        "into referenceImageUrls automatically, so you never have to copy paths by hand.",
      ),
      referenceImageUrls: z.array(z.string()).optional().describe(
        "Portrait or scene reference images: public https URLs, data URIs, or local paths. " +
        "Combined with any images registered on `characters`.",
      ),
      firstFrameUrl: z
        .string()
        .optional()
        .describe(
          "Image to pin as the first frame: public https URL, data URI, or a local path from " +
          "extract_last_frame. This is what carries continuity across a cut.",
        ),
      lastFrameUrl: z
        .string()
        .optional()
        .describe(
          "Image to pin as the last rendered frame. Ignored unless pin is \"both\". An end pin " +
          "makes the model reach the pose early and then hold.",
        ),
      pin: z.enum(["start", "both"]).default("start").describe(
        "start pins the first frame only. both also pins lastFrameUrl.",
      ),
      voiceId: z.string().optional().describe(
        "Built-in voice id, such as rex. Sent as reference_audios voice_id. " +
        "A spoken line uses the literal token <AUDIO_0>. Time the clip to a rex track written first.",
      ),
      negative: z.string().optional().describe(
        "Known limits and hallucinations. Used by lint and the checklist. Never sent.",
      ),
      admission: TakeAdmissionSchema.optional(),
      ledger: z.object({
        locations: z.array(LocationSchema).optional(),
        props: z.array(PropRecordSchema).optional(),
        wardrobeEvents: z.array(WardrobeEventSchema).optional(),
        propEvents: z.array(PropEventSchema).optional(),
        shotSteps: z.array(z.object({
          shot: z.number().int().min(1),
          steps: z.array(z.string()),
        })).optional(),
        voiceId: z.string().optional(),
        spokenLines: z.array(z.object({ shot: z.number().int(), line: z.string() })).optional(),
        humanVisionSignOff: z.boolean().optional(),
        hasPortrait: z.boolean().optional(),
      }).optional().describe(
        "Continuity ledger for this clip. Without a ledger or contracts the gate is unchecked " +
        "and confirm cannot spend.",
      ),
      contracts: z.array(ShotContractSchema).optional(),
      overrideValidation: z.boolean().default(false),
      confirm: z.boolean().default(false).describe(
        "Must be true to spend. Call once without it for the estimate.",
      ),
      durationSeconds: z.number().min(1).max(15).default(8),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("720p").describe(
        "Output resolution. Costs more at higher settings: at 1s, 720p billed 0.14 and 1080p " +
        "0.25. Left unset the API returns a soft 848x480, so 720p is the sensible default.",
      ),
      model: z.string().default("grok-imagine-video-1.5"),
      waitForCompletion: z.boolean().default(true),
      timeoutSeconds: z.number().min(10).max(600).default(240),
      jobId: z.string().optional().describe(
        "Film whose cumulative spend this clip counts toward.",
      ),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    if (args.jobId) await refreshJobsFromDisk();
    const {
      waitForCompletion,
      timeoutSeconds,
      characters,
      ledger,
      contracts,
      overrideValidation,
      confirm,
      pin,
      voiceId,
      approvedUsd,
      approvedKind,
      approvedFingerprint,
      budgetUsd,
      jobId,
      ...rest
    } = args;
    const gate = gateRenderSequence({
      plan: continuityPlanFromRenderArgs({
        shots: [{ prompt: args.prompt, locationId: undefined }],
        characters,
        ledger: ledger ? { ...ledger, voiceId: voiceId ?? ledger.voiceId } : undefined,
      }),
      contracts: contracts as ShotContract[] | undefined,
      overrideValidation,
    });
    const decision = decideSpend(confirm, gate);
    const clipLint = lintSentPrompt(args.prompt, args.negative);
    const clipRate = ratePerSecond(args.resolution);
    const clipEstimate = Math.round(args.durationSeconds * clipRate * 100) / 100;
    const clipFingerprint = quoteFingerprint({
      kind: "video",
      prompt: args.prompt,
      resolution: args.resolution,
      pin: pin ?? "start",
      durations: [args.durationSeconds],
    });
    const clipJob = jobId ? sequenceJobs.get(jobId) : undefined;
    const clipPaid = await quoteGate(
      { confirm, approvedUsd, approvedKind, approvedFingerprint, overrideValidation, budgetUsd: budgetUsd ?? clipJob?.spendLedger?.thresholdUsd },
      "video",
      clipEstimate,
      clipFingerprint,
      clipJob,
    );
    let budgetNote: NoteOutcome | undefined;
    if (jobId && budgetUsd !== undefined) budgetNote = await rememberBudget(jobId, budgetUsd);
    const clipCostRefusal = costRefusal(clipPaid, deferredField(budgetNote, "budgetNote"));
    if (clipCostRefusal) return clipCostRefusal;
    const clipContract = {
      sentPrompt: args.prompt,
      lintHits: clipLint,
      resolution: args.resolution,
      durationSeconds: args.durationSeconds,
      pin: pin ?? "start",
      startFrame: rest.firstFrameUrl ?? null,
      closingFrameSent: (pin ?? "start") !== "start" && Boolean(rest.lastFrameUrl),
      referenceImageUrls: rest.referenceImageUrls ?? [],
      voiceId: voiceId ?? null,
      negativeStored: args.negative ?? "",
      quote: {
        totalUsd: clipEstimate,
        ratePerSecond: clipRate,
        basis: `${args.durationSeconds}s at $${clipRate.toFixed(2)}/s for ${args.resolution} = $${clipEstimate.toFixed(2)}.`,
      },
    };
    if (clipLint.length > 0) {
      return refusal({
        action: "refused",
        willRender: false,
        contract: clipContract,
        contractValidation: gate,
        message:
          "The prompt fails the check. Show the failures and the prompt. Edit it before another try. Nothing was spent.",
      });
    }
    if (decision !== "spend") {
      return refusal({
        action: decision === "estimate" ? "estimate-only" : "refused",
        willRender: false,
        estimate: { totalUsd: clipEstimate, resolution: args.resolution, isEstimate: true },
        contract: clipContract,
        contractValidation: gate,
        ...costFields(clipPaid),
        ...deferredField(budgetNote, "budgetNote"),
        message: decision === "estimate"
          ? "Nothing was spent. Show the sent prompt, lint hits, pin, voice, duration, resolution, and the quote. Call again with confirm: true only after the gate passes and the user approves."
          : (gate.message ?? RENDER_BLOCKED_BY_CONTRACT),
      });
    }
    const sessionRefusal = await refuseIfSessionWillNotLast(args.durationSeconds * 1000);
    if (sessionRefusal) return sessionRefusal;

    const job: VideoJob = {
      ...rest,
      pin,
      voiceId: voiceId ?? ledger?.voiceId,
    };

    const { urls, missing } = mergeCharacterReferences(characters, rest.referenceImageUrls);
    const prepared = await withPersonCutouts(characters, urls);
    job.referenceImageUrls = prepared.length > 0 ? prepared : undefined;

    const result = await generateGrokClip(job, { waitForCompletion, timeoutSeconds });
    const clipCharge = chargeForProviderResult(result, clipPaid.quote.usd);
    let spendNote: NoteOutcome | undefined;
    if (jobId && clipCharge.record) {
      spendNote = await recordFilmCost(jobId, "video", clipCharge.usd, {
        estimated: clipCharge.estimated,
        uncertain: clipCharge.uncertain,
        reason: clipCharge.reason,
      });
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...result,
          message: result.videoUrl
            ? "Clip generated. Use extract_last_frame on it to carry continuity into the next shot."
            : result.requestId
              ? "Generation submitted. Poll statusUrl for the finished clip."
              : "Stub response: no credential available, so nothing was generated.",
          referenceImagesUsed: job.referenceImageUrls?.length ?? 0,
          unknownCharacters: missing.length > 0 ? missing : undefined,
          ...costFields(clipPaid),
          ...deferredField(budgetNote, "budgetNote"),
          ...deferredField(spendNote, "spendNote"),
          args,
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "extend_clip",
  {
    description:
      "Extend an existing clip from its last frame, producing one longer continuous take. " +
      "Requires a clip of 2-15 seconds and an extension of 2-10 seconds. " +
      "Only available with an XAI_API_KEY: the subscription session proxy does not expose the " +
      "extensions route, so on the session path this reports that clearly instead of guessing. " +
      "There is no continuity ledger on an extension, so confirm spends only when overrideValidation " +
      "is set. Otherwise the gate is unchecked and nothing is bought.",
    inputSchema: z.object({
      videoUrl: z.string().describe("Public https URL of the source clip (2-15 seconds)."),
      prompt: z.string(),
      durationSeconds: z.number().min(2).max(10).default(6),
      model: z.string().default("grok-imagine-video"),
      waitForCompletion: z.boolean().default(true),
      timeoutSeconds: z.number().min(10).max(600).default(240),
      confirm: z.boolean().default(false),
      overrideValidation: z.boolean().default(false),
      jobId: z.string().optional().describe(
        "Film whose cumulative spend this extension counts toward.",
      ),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    if (args.jobId) await refreshJobsFromDisk();
    const extensionUsd = Math.round(args.durationSeconds * ratePerSecond("720p") * 100) / 100;
    const extensionJob = args.jobId ? sequenceJobs.get(args.jobId) : undefined;
    const extensionPaid = await quoteGate(
      { ...args, budgetUsd: args.budgetUsd ?? extensionJob?.spendLedger?.thresholdUsd },
      "extend",
      extensionUsd,
      quoteFingerprint({
        kind: "extend",
        prompt: args.prompt,
        durationSeconds: args.durationSeconds,
        resolution: "720p",
      }),
      extensionJob,
    );
    let extensionBudget: NoteOutcome | undefined;
    if (args.jobId && args.budgetUsd !== undefined) extensionBudget = await rememberBudget(args.jobId, args.budgetUsd);
    const extensionCostRefusal = costRefusal(extensionPaid);
    if (extensionCostRefusal) return extensionCostRefusal;
    const extensionGate = gateRenderSequence({ overrideValidation: args.overrideValidation });
    if (decideSpend(args.confirm, extensionGate) !== "spend") {
      return refusal({
        action: args.confirm ? "refused" : "estimate-only",
        willRender: false,
        contractValidation: extensionGate,
        ...costFields(extensionPaid),
        ...deferredField(extensionBudget, "budgetNote"),
        message: args.confirm
          ? (extensionGate.message ?? RENDER_UNCHECKED)
          : "Nothing was spent. An extension has no ledger, so confirm also needs overrideValidation.",
      });
    }
    const extensionSession = await refuseIfSessionWillNotLast(args.durationSeconds * 1000);
    if (extensionSession) return withCost(extensionSession, extensionPaid);

    if (paidStubEnabled()) {
      let spendNote: NoteOutcome | undefined;
      if (args.jobId) {
        spendNote = await recordFilmCost(args.jobId, "extend", extensionPaid.quote.usd, { estimated: true });
      }
      return { content: [{ type: "text", text: JSON.stringify({ requestId: "stub", status: "submitted", extendedBy: args.durationSeconds, costUsd: extensionPaid.quote.usd, costEstimated: true, ...costFields(extensionPaid), ...deferredField(extensionBudget, "budgetNote"), ...deferredField(spendNote, "spendNote") }, null, 2) }] };
    }

    const resolved = resolveVideoCredential();
    if (resolved.ok === false) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No credential", reason: resolved.reason, ...costFields(extensionPaid) }, null, 2) }] };
    }
    const credential = resolved.credential;

    if (credential.kind === "session") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Extension not available on the subscription session",
            detail:
              "The Grok CLI inference proxy answers POST /v1/videos/extensions with HTTP 405. " +
              "Extension needs an XAI_API_KEY pointed at api.x.ai.",
            workaround:
              "Use generate_controlled_clip with firstFrameUrl set to the previous clip's last frame " +
              "(from extract_last_frame). That produces a new shot continuing from the same image and " +
              "works on the subscription session.",
            auth: toolAuth(credential.source),
          }, null, 2),
        }],
      };
    }

    const headers = { "Authorization": `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const submitRes = await fetch(`${credential.baseUrl}/v1/videos/extensions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        prompt: args.prompt,
        duration: args.durationSeconds,
        video: { url: args.videoUrl },
      }),
    });
    if (!submitRes.ok) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: `API error ${submitRes.status}`, detail: await submitRes.text(), auth: toolAuth(credential.source) }, null, 2),
        }],
      };
    }
    const submitted = (await submitRes.json()) as { request_id?: string };
    const requestId = submitted.request_id;
    if (!requestId) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No request_id returned" }, null, 2) }] };
    }

    if (!args.waitForCompletion) {
      let spendNote: NoteOutcome | undefined;
      if (args.jobId) spendNote = await recordFilmCost(args.jobId, "extend", extensionPaid.quote.usd, { estimated: true });
      return { content: [{ type: "text", text: JSON.stringify({ requestId, status: "submitted", statusUrl: `${credential.baseUrl}/v1/videos/${requestId}`, costUsd: extensionPaid.quote.usd, costEstimated: true, ...costFields(extensionPaid), ...deferredField(extensionBudget, "budgetNote"), ...deferredField(spendNote, "spendNote") }, null, 2) }] };
    }

    const deadline = Date.now() + args.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const statusRes = await fetch(`${credential.baseUrl}/v1/videos/${requestId}`, { headers });
      if (!statusRes.ok) continue;
      const poll = (await statusRes.json()) as { status?: string; video?: { url?: string; duration?: number }; usage?: Record<string, unknown> };
      if (poll.status === "done" || poll.status === "completed") {
        const extendCost = costUsdFromUsage(poll.usage);
        const estimated = !((extendCost ?? 0) > 0);
        let spendNote: NoteOutcome | undefined;
        if (args.jobId) {
          spendNote = await recordFilmCost(args.jobId, "extend", estimated ? extensionPaid.quote.usd : (extendCost ?? 0), estimated ? { estimated: true } : undefined);
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              requestId,
              status: "completed",
              videoUrl: poll.video?.url,
              durationSeconds: poll.video?.duration,
              extendedBy: args.durationSeconds,
              auth: toolAuth(credential.source),
              ...costFields(extensionPaid),
              ...deferredField(extensionBudget, "budgetNote"),
              ...deferredField(spendNote, "spendNote"),
            }, null, 2),
          }],
        };
      }
      if (poll.status === "failed" || poll.status === "expired") {
        return { content: [{ type: "text", text: JSON.stringify({ requestId, status: poll.status, detail: poll }, null, 2) }] };
      }
    }
    let spendNote: NoteOutcome | undefined;
    if (args.jobId) spendNote = await recordFilmCost(args.jobId, "extend", extensionPaid.quote.usd, { estimated: true });
    return { content: [{ type: "text", text: JSON.stringify({ requestId, status: "timeout", statusUrl: `${credential.baseUrl}/v1/videos/${requestId}`, costUsd: extensionPaid.quote.usd, costEstimated: true, ...costFields(extensionPaid), ...deferredField(extensionBudget, "budgetNote"), ...deferredField(spendNote, "spendNote") }, null, 2) }] };
  }
);

// Downloaded clips belong with the film, not in a temp folder.
//
// They used to land in the system temp dir, which is cleared by a reboot or a
// cleaner. The job record still pointed at them, so list_films would report a
// finished film whose footage had quietly vanished, and retry_shot would try to
// re-assemble from files that were no longer there. A paid render is the one
// thing here that cannot be regenerated for free, so it goes in ~/.theshow/media
// beside the film and the board frames.
const DOWNLOAD_DIR = OUTPUT_DIR;

/**
 * Accept a public https URL, a file:// URL, or a plain local path and return a
 * readable local file, downloading remote media once and caching it by URL hash.
 */
async function resolveToLocalFile(input: string): Promise<string> {
  if (input.startsWith("https://") || input.startsWith("http://")) {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const digest = createHash("sha1").update(input).digest("hex").slice(0, 16);
    const ext = input.match(/\.([a-z0-9]{2,5})(?:$|\?)/i)?.[1] ?? "mp4";
    const target = join(DOWNLOAD_DIR, `src-${digest}.${ext}`);

    // Reuse an existing download so repeat calls stay cheap.
    const existing = await probeDuration(target);
    if (existing !== undefined) return target;

    const res = await fetch(input, { redirect: "follow" });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${input}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error(`Download produced no data for ${input}`);
    await writeFile(target, bytes);
    return target;
  }

  const path = input.startsWith("file://") ? new URL(input).pathname : input;
  const exists = await probeDuration(path);
  if (exists === undefined) throw new Error(`Not a readable media file: ${path}`);
  return path;
}

server.registerTool(
  "extract_last_frame",
  {
    description:
      "Extract the last frame of a video as a PNG for use as firstFrameUrl or lastFrameUrl on the " +
      "next shot. " +
      "Returns a local file path plus a data URI, either of which can be passed straight to " +
      "generate_controlled_clip as firstFrameUrl to carry continuity across a cut.",
    inputSchema: z.object({
      videoUrl: z.string().describe("Public https URL, file:// path, or a local path from a previous run."),
      includeDataUri: z.boolean().default(true),
    }),
  },
  async (args) => {
    const localPath = await resolveToLocalFile(args.videoUrl);
    const frame = await extractLastFrame({ file: localPath });
    const durationSeconds = await probeDuration(localPath);

    const payload: ClipResult & Record<string, unknown> = {
      status: "ok",
      framePath: frame.path,
      frameBytes: frame.bytes,
      sourceVideo: args.videoUrl,
      sourceDurationSeconds: durationSeconds,
      ffmpeg: frame.ffmpeg,
      message:
        "Use framePath or dataUri as firstFrameUrl on the next shot to carry continuity. " +
        "The data URI is self-contained, so it survives a copy into another machine.",
    };
    if (args.includeDataUri) {
      payload.dataUri = await pathToDataUrl(frame.path);
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

/**
 * Generate one still image. This is the cheap half of the pipeline and the thing
 * that makes a stills-first workflow possible: at two cents a still, boarding an
 * eight-shot film is about eighteen cents against roughly nine dollars of 720p
 * footage, so the pictures can be reviewed before the expensive half runs.
 */
server.registerTool(
  "generate_still",
  {
    description:
      "Generate a single image with Grok Imagine Image and save it locally. About $0.02 per " +
      "still, against $0.14 a second for video, which is what makes it worth boarding a film as " +
      "pictures first. Returns the image URL, a local path, and the cost actually billed. Use it " +
      "for storyboard frames, or call board_film to do a whole film at once. Character references " +
      "are merged exactly as on a clip, so a portrait registered with create_character keeps the " +
      "face consistent from the board through to the render.",
    inputSchema: z.object({
      prompt: z.string().describe(
        "What the still shows. Describe the frame, not the motion: subject, framing, light, mood.",
      ),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9").describe(
        "Shape of the still. Sent as aspect_ratio, which is what the video route takes; if the " +
        "image route rejects it the call falls back automatically and reports which key worked.",
      ),
      referenceImageUrls: z.array(z.string()).optional().describe(
        "Portrait or location references: public https URLs, data URIs, or local paths. Inlined " +
        "for the API, and shrunk harder as the list grows so the request body stays within limits.",
      ),
      baseImageUrl: z.string().optional().describe(
        "Edit this picture instead of generating a new one. The prompt is sent word for word. " +
        "Omit it and the still is a fresh generation, as before. A local path must be inside the " +
        "output folder or a character folder.",
      ),
      imageOrder: z.enum(["portrait-first", "plate-first"]).optional().describe(
        "Default portrait-first sends the character reference first and the room last. " +
        "plate-first sends the room first, for placing a person into a set. Opening a door in " +
        "that same two-image call was unreliable: edit the plate alone first, then place the character.",
      ),
      negative: z.string().optional().describe(
        "Known limits and hallucinations. Used by lint and the checklist. Never sent.",
      ),
      admission: TakeAdmissionSchema.optional(),
      confirm: z.boolean().default(false).describe(
        "Must be true to spend about $0.02. Call without it for the estimate. The prompt is sent " +
        "word for word either way.",
      ),
      characters: z.array(z.string()).optional().describe(
        "Names of characters created with create_character. Their reference images are merged " +
        "into referenceImageUrls automatically.",
      ),
      jobId: z.string().optional().describe(
        "Film whose cumulative spend this still counts toward. Omit it and the still is not added to a film.",
      ),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    const { urls, missing } = mergeCharacterReferences(args.characters, args.referenceImageUrls);
    const imageRefs = [args.baseImageUrl, ...(args.referenceImageUrls ?? []), ...urls]
      .filter((ref): ref is string => Boolean(ref && ref.trim()));
    const roots = [OUTPUT_DIR, charactersRoot()];
    const rejected = imageRefs.find((ref) => !localImageRefAllowed(ref, roots));
    if (rejected) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "refused",
            willSpend: false,
            error:
              "A local image has to be inside the output folder or a character folder. " +
              "https URLs and data images are still accepted.",
          }, null, 2),
        }],
      };
    }
    if (args.jobId) await refreshJobsFromDisk();
    const stillFingerprint = quoteFingerprint({
      kind: "still",
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
      baseImageUrl: args.baseImageUrl ?? "",
      referenceImageUrls: args.referenceImageUrls ?? [],
    });
    const stillJob = args.jobId ? sequenceJobs.get(args.jobId) : undefined;
    const stillPaid = await quoteGate(
      { ...args, budgetUsd: args.budgetUsd ?? stillJob?.spendLedger?.thresholdUsd },
      "still",
      STILL_USD,
      stillFingerprint,
      stillJob,
    );
    let stillBudget: NoteOutcome | undefined;
    if (stillJob && args.budgetUsd !== undefined && args.jobId) stillBudget = await rememberBudget(args.jobId, args.budgetUsd);
    const stillCostRefusal = costRefusal(stillPaid, deferredField(stillBudget, "budgetNote"));
    if (stillCostRefusal) return stillCostRefusal;
    if (args.confirm !== true) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: "estimate-only",
            willSpend: false,
            estimate: {
              estimatedUsd: STILL_USD,
              perStillUsd: STILL_USD,
              isEstimate: true,
              basis: "One still at $0.02. Nothing is generated until confirm is true.",
            },
            ...costFields(stillPaid),
            ...deferredField(stillBudget, "budgetNote"),
            next: "Show the estimate. Call again with confirm: true only after the user approves.",
          }, null, 2),
        }],
      };
    }
    const prepared = await withPersonCutouts(args.characters, urls);
    const result = await generateGrokStill(
      {
        prompt: args.prompt,
        aspectRatio: args.aspectRatio,
        referenceImageUrls: prepared.length > 0 ? prepared : undefined,
        baseImageUrl: args.baseImageUrl,
        imageOrder: args.imageOrder,
        negative: args.negative,
        admission: args.admission,
      },
      { outputDir: OUTPUT_DIR },
    );

    const stillCharge = chargeForProviderResult(result, stillPaid.quote.usd);
    let stillSpend: NoteOutcome | undefined;
    if (args.jobId && stillCharge.record) {
      stillSpend = await recordFilmCost(args.jobId, "still", stillCharge.usd, {
        estimated: stillCharge.estimated,
        uncertain: stillCharge.uncertain,
        reason: stillCharge.reason,
      });
    }

    if (!result.localPath) {
      // Never a fabricated URL: a board built on an invented path is worse than
      // no board, because the failure only shows up when the video is rendered.
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: result.error ?? "Still generation failed",
            detail: result.detail,
            hint: result.hint,
            costUsd: result.costUsd,
            referenceImagesUsed: urls.length,
            unknownCharacters: missing.length > 0 ? missing : undefined,
            ...costFields(stillPaid),
            ...deferredField(stillBudget, "budgetNote"),
            ...deferredField(stillSpend, "spendNote"),
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          imageUrl: result.imageUrl,
          imagePath: result.localPath,
          fileUrl: `file://${result.localPath}`,
          mimeType: result.mimeType,
          aspectRatio: args.aspectRatio,
          aspectRatioParam: result.aspectRatioParam,
          costUsd: result.costUsd,
          usage: result.usage,
          billedTo: result.billedTo,
          auth: toolAuth(result.auth),
          referenceImagesUsed: urls.length,
          unknownCharacters: missing.length > 0 ? missing : undefined,
          ...costFields(stillPaid),
          ...deferredField(stillBudget, "budgetNote"),
          ...deferredField(stillSpend, "spendNote"),
          message:
            "Pass imagePath as firstFrameUrl or lastFrameUrl on generate_controlled_clip, or as a " +
            "reference. board_film does a whole film's frames in one call.",
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "assemble_film",
  {
    description:
      "Assemble ordered clips into a single film with real FFmpeg, normalising size, frame rate " +
      "and audio so chained generations stitch cleanly. Accepts public https URLs, file:// paths, " +
      "or local paths from earlier tool calls. Joins are hard cuts by default: on real chained " +
      "clips a cross-fade double-exposes drifting textures, while a cut stays sharp. Use a short " +
      "fade only when two shots continue one camera move with the same framing.",
    inputSchema: z.object({
      clips: z.array(z.object({
        url: z.string(),
        title: z.string().optional(),
        trimStart: z.number().min(0).optional(),
        trimEnd: z.number().min(0).optional(),
      })).min(1),
      fadeDuration: z.number().min(0).max(5).default(0).describe(
        "Seconds of cross-fade at each join. 0 is a hard cut: sharp, and right whenever the shot " +
        "changes framing. Use 0.15 to 0.3 only when two shots continue one camera move with the " +
        "same framing, where a cut would visibly pop.",
      ),
      audioTrackUrl: z.string().optional().describe(
        "Optional music, narration or ambience for the whole film: an https URL, a file:// URL, " +
        "or a local path such as a chat attachment. It must cover the whole film. A shorter bed " +
        "is refused. Volume 0 omits it.",
      ),
      audioTrackVolume: z.number().min(0).max(4).default(0.25).describe(
        "Bed level. 0.25 sits under dialogue; 1.0 is a full-volume music video; 0 omits the bed.",
      ),
      audioTrackFadeOutSeconds: z.number().min(0).max(30).default(1.5),
      clipAudio: z.enum(["keep", "mute", "replace"]).default("keep").describe(
        "keep mixes each clip's own audio. mute drops it and keeps the bed or silence. " +
        "replace drops it so the bed is the soundtrack.",
      ),
    }),
  },
  async (args) => {
    const localFiles = [];
    for (const clip of args.clips) {
      const file = await resolveToLocalFile(clip.url);
      localFiles.push({ file, trimStart: clip.trimStart, trimEnd: clip.trimEnd });
    }

    const result = await assembleClips({
      clips: localFiles,
      fadeDuration: args.fadeDuration,
      audioTrackFile: args.audioTrackUrl ? await resolveToLocalFile(args.audioTrackUrl) : undefined,
      audioTrackVolume: args.audioTrackVolume,
      audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
      clipAudio: args.clipAudio,
    });
    const durationSeconds = await probeDuration(result.path);
    const bytes = (await import("node:fs/promises")).stat(result.path).then((s) => s.size);
    const payload = {
      status: "ok",
      filmPath: result.path,
      fileUrl: `file://${result.path}`,
      clipCount: args.clips.length,
      durationSeconds,
      fileBytes: await bytes,
      crossFades: result.mode === "xfade",
      mode: result.mode,
      fadeSeconds: "fadeSeconds" in result ? result.fadeSeconds : undefined,
      audioBed: result.audioBed ? {
        source: args.audioTrackUrl,
        volume: args.audioTrackVolume,
        note: "Looped or trimmed to the film, faded out at the end, mixed under the clips' audio.",
      } : undefined,
      message:
        result.mode === "xfade"
          ? "Film assembled with cross-fades."
          : "Film assembled with hard cuts.",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

export function startOwnedJobHeartbeat(): () => void {
  return startJobHeartbeat(() => {
    const now = Date.now();
    for (const job of sequenceJobs.values()) {
      const ownsRun = job.state === "running" && job.owner?.token === processToken;
      const ownsClaim = job.claim?.token === processToken;
      if (!ownsRun && !ownsClaim) continue;
      if (ownsRun && job.owner) job.owner.heartbeatAt = now;
      if (ownsClaim && job.claim) job.claim.heartbeatAt = now;
      void persistJob(job);
    }
  });
}

export async function startStdioServer(): Promise<void> {
  if (process.env.THESHOW_TRANSPORT === "http") {
    throw new Error(
      "THESHOW_TRANSPORT=http is the Streamable HTTP entry, mcp/http-server.ts. " +
        "This process is the desktop stdio server and does not open a port.",
    );
  }
  // Load films saved by earlier sessions before taking requests, so a user who
  // comes back tomorrow can still continue or repair what they paid for.
  await loadJobsFromDisk();
  // Same reason for the cast: a character created last week, with the photos
  // that make it that character, has to be here for today's film.
  await loadCharactersFromDisk();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("theShow MCP server running on stdio (enhanced test build)");
  const stopBeat = startOwnedJobHeartbeat();
  installShutdown(async () => {
    stopBeat();
    await flushJobWrites();
  });
}

/**
 * Render a whole shot sequence as one continuous chain.
 *
 * The tools already supported this, but only if the model drove it: render,
 * extract, thread the frame path into the next call, repeat, then assemble. That
 * is a lot of bookkeeping to get right by hand, and every dropped frame path is
 * a visible cut plus a wasted render. Doing the loop in one process makes the
 * chain the default rather than a recipe the model has to remember.
 *
 * Cost is the reason this is a separate explicit call: each shot is a real
 * charge, so it reports what it will spend before it spends it, refuses to start
 * unless told to go, and reports actual cost at the end.
 */
/** Measured cost per second of rendered video, by output resolution. */
const RESOLUTION_RATES: Record<string, number> = { "480p": 0.08, "720p": 0.14, "1080p": 0.25 };

function ratePerSecond(resolution: string): number {
  return RESOLUTION_RATES[resolution] ?? RESOLUTION_RATES["720p"];
}
/**
 * Read a resolution back out of a form option label.
 *
 * The form has to show prices, and an elicitation enum is a plain list of
 * strings with no room for a label separate from its value. So the value is the
 * label: "720p — $0.14/s, 8s shot $1.12". This pulls the leading token back out
 * and refuses anything it does not recognise rather than guessing, because a
 * silent fallback here would reprice a render behind the user's back.
 */
export function resolutionFromLabel(value: unknown): "480p" | "720p" | "1080p" | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(480p|720p|1080p)\b/);
  return (match?.[1] as "480p" | "720p" | "1080p" | undefined) ?? undefined;
}

/**
 * In-flight and finished sequence renders, keyed by job id.
 *
 * render_sequence has to return before the client's request timeout, and a
 * three-shot chain already runs past the 60-second default. The first version
 * rendered synchronously and the client gave up while the server was still
 * working: the clips landed on disk, the money was spent, and the caller got a
 * timeout instead of a film. So a long sequence now registers a job, returns its
 * id immediately, and is polled with check_sequence.
 */
export type SequenceJob = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "completed" | "stopped" | "failed";
  /** Who is driving a running render, so another process does not reap it. */
  owner?: JobOwner;
  /** Set while this film is being resumed or repaired, so a second process does not start another render. */
  claim?: JobOwner;
  /** Increases on every queued write. An older snapshot is not written over a newer one. */
  revision?: number;
  shotCount: number;
  completed: number;
  estimateUsd: number;
  spentUsd: number;
  shots: Array<{
    index: number;
    title: string;
    status: string;
    videoUrl?: string;
    costUsd?: number;
    error?: string;
    /** Local file for an already-rendered shot, so a resume can reuse it. */
    localPath?: string;
    /** That shot's extracted last frame: the anchor for whatever comes next. */
    framePath?: string;
    /**
     * The last frame this shot was pinned to, when it was bookended. Kept so a
     * resumed or repaired film renders the same frames it was boarded with
     * instead of quietly chaining from an extracted frame instead.
     */
    lastFrameUrl?: string;
    /** Local copy of that pinned frame, when it was a file on this machine. */
    lastFramePath?: string;
    /**
     * How well this clip's real last frame matched the frame it was pinned to,
     * 1 being identical. Undefined when the shot was not pinned at its close, or
     * when the comparison could not be taken.
     */
    closingFrameAgreement?: number;
    /** The prompt that produced it, so a repair can re-render the same beat. */
    prompt?: string;
    durationSeconds?: number;
    /** The opening frame actually sent for this shot. Absent on jobs rendered before it was recorded. */
    openingFramePath?: string;
    pinUsed?: "start" | "both";
    /** Present only when the caller sent shotType on a job created after it was stored. */
    shotType?: string;
    /** Present only when a stored shot already carries framing. render_sequence does not ask for it. */
    framing?: string;
  }>;
  /** Set when this job continued an earlier one, so cost and provenance stay honest. */
  resumedFrom?: { jobId: string; fromShot: number };
  carriedOverUsd?: number;
  /**
   * Everything needed to rebuild this film's assembly without asking again.
   * A repair re-assembles using these, so a fixed shot joins the same way the
   * original did instead of quietly changing the film's look.
   */
  settings?: {
    aspectRatio: string;
    resolution: string;
    model: string;
    fadeDuration: number;
    continuity?: string;
    characters?: string[];
    audioTrackFile?: string;
    audioTrackVolume?: number;
    audioTrackFadeOutSeconds?: number;
    clipAudio?: "keep" | "mute" | "replace";
    pin?: "start" | "both";
    voiceId?: string;
    assemble: boolean;
  };
  /** The frame the first shot chained from, kept so a repair of shot 1 can match it. */
  startFramePath?: string;
  /** Non-fatal things the user has to know, such as a repair leaving later shots stale. */
  warnings?: string[];
  /** Set when this job exists to replace one shot of an earlier film. */
  repairedFrom?: { jobId: string; shotIndex: number; originalCostUsd?: number };
  filmPath?: string;
  fileUrl?: string;
  filmDurationSeconds?: number;
  filmBytes?: number;
  lastFramePath?: string;
  unknownCharacters?: string[];
  error?: string;
  /** Wardrobe events and the per-location prop ledger, so a resumed film keeps them. */
  ledger?: {
    locations: LocationRecord[];
    props: PropRecord[];
    wardrobeEvents: WardrobeEvent[];
    propEvents: PropEvent[];
    shots?: ShotContinuity[];
    shotSteps?: Array<{ shot: number; steps: string[] }>;
    voiceId?: string;
    promptStyle?: "legacy" | "sections-v2";
    spokenLines?: ContinuityPlan["spokenLines"];
    humanVisionSignOff?: boolean;
    hasPortrait?: boolean;
    scaleMarks?: ContinuityPlan["scaleMarks"];
    bodyClearance?: ContinuityPlan["bodyClearance"];
    tier1?: ContinuityPlan["tier1"];
  };
  /** Versioned continuity review. Absent on jobs written before Phase 1. */
  continuityReview?: ContinuityReview;
  /** Versioned spend totals. Absent on older jobs. */
  spendLedger?: PersistedSpend;
  /** Versioned shot graph. Absent on older jobs. */
  dependencies?: DependencyGraph;
  /** Versioned repair quote. Absent on older jobs. Approving it does not render. */
  repairProposal?: RepairProposal;
  /**
   * Character name, updatedAt, and reference hashes at the moment this job was
   * created. Absent on jobs written before it was stored. Legacy jobs are not backfilled.
   */
  characterSnapshots?: Array<{
    name: string;
    updatedAt: string;
    references: Array<{ path: string; sha256: string }>;
  }>;
};

/**
 * Film jobs, kept in memory for speed and mirrored to disk so a film survives a
 * restart.
 *
 * The memory-only version meant a session ended and the film was gone: the
 * clips were still there, the settings and the shot list and the link between
 * them were not. For something the user paid real money for, that is the wrong
 * failure. Every write now mirrors to a JSON file, and the store loads what it
 * finds on startup.
 */
const sequenceJobs = new Map<string, SequenceJob>();
const jobRevision = new Map<string, number>();
const jobWriteChain = new Map<string, Promise<void>>();

function claimPath(jobId: string): string {
  return join(JOBS_DIR, `${jobId}.claim`);
}

function noteRevision(job: SequenceJob): void {
  if (typeof job.revision === "number") {
    jobRevision.set(job.id, Math.max(jobRevision.get(job.id) ?? 0, job.revision));
  }
}

/**
 * One writer chain per job. Each call snapshots the job and takes the next
 * revision. A heartbeat that was queued before completion is dropped once a
 * later snapshot exists, so disk cannot go back to "running" and lose the film path.
 */
export async function persistJob(job: SequenceJob): Promise<void> {
  let consumed: string[] = [];
  if (thisProcessOwns(job)) {
    if (beforeJournalMerge) await beforeJournalMerge();
    consumed = await applyQueuedNotes(job);
  }
  const revision = (jobRevision.get(job.id) ?? 0) + 1;
  job.revision = revision;
  jobRevision.set(job.id, revision);
  const snapshot = structuredClone(job);
  const previous = jobWriteChain.get(job.id) ?? Promise.resolve();
  const write = previous.then(async () => {
    if (jobRevision.get(job.id) !== revision) return;
    try {
      await atomicWriteFile(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(snapshot, null, 2));
      if (snapshot.claim) await atomicWriteFile(claimPath(job.id), JSON.stringify(snapshot.claim));
      else await unlink(claimPath(job.id)).catch(() => undefined);
      if (beforeJournalDelete) await beforeJournalDelete();
      for (const file of consumed) await unlink(file).catch(() => undefined);
      noteJobPersisted(snapshot, JOBS_DIR);
    } catch (err) {
      // A failed write must never lose the render or the queued notes. The notes
      // stay on disk until a later rename of this ledger succeeds.
      console.error(`theShow: could not persist job ${job.id}:`, err);
    }
  });
  jobWriteChain.set(job.id, write);
  trackWrite(write);
  await write;
}

async function reapIfOwnerGone(job: SequenceJob): Promise<void> {
  if (job.state !== "running" || !jobShouldStop(job.owner)) return;
  const filmPath = job.filmPath;
  const fileUrl = job.fileUrl;
  job.state = "stopped";
  job.error =
    "The server stopped while this film was rendering. Shots already finished are kept; " +
    "the rest were never rendered.";
  job.finishedAt = job.finishedAt ?? Date.now();
  if (filmPath) job.filmPath = filmPath;
  if (fileUrl) job.fileUrl = fileUrl;
  await persistJob(job);
}

function otherProcessHolds(owner: JobOwner | undefined): boolean {
  if (!owner) return false;
  if (owner.token === processToken && owner.pid === process.pid) return false;
  return !jobShouldStop(owner);
}

const ALREADY_RUNNING = "already running in another process";
const ALREADY_RUNNING_HERE = "already running in this process";
const TAKING_OVER = "another process is taking over this film; try again in a few seconds";
const CLAIM_EMPTY_GRACE_MS = 1_000;

function claimBusyMessage(owner: JobOwner | undefined): string {
  if (owner && owner.token === processToken && owner.pid === process.pid) return ALREADY_RUNNING_HERE;
  return ALREADY_RUNNING;
}

/** Keep a terminal in-memory film, including its path, ahead of a stale running copy on disk. */
function mergeFromDisk(memory: SequenceJob | undefined, disk: SequenceJob): SequenceJob {
  if (!memory) return disk;
  const memRev = memory.revision ?? 0;
  const diskRev = disk.revision ?? 0;
  if (memRev > diskRev) return memory;
  if (memory.state !== "running" && disk.state === "running") return memory;
  if (memory.filmPath && !disk.filmPath) {
    return { ...disk, filmPath: memory.filmPath, fileUrl: disk.fileUrl ?? memory.fileUrl };
  }
  return disk;
}

/** Re-read job files so a film started by the other transport is visible here. */
export async function refreshJobsFromDisk(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(JOBS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(JOBS_DIR, name), "utf8");
      const job = JSON.parse(raw) as SequenceJob;
      if (!job?.id) continue;
      const memory = sequenceJobs.get(job.id);
      if (memory?.owner?.token === processToken && memory.state === "running") continue;
      const chosen = mergeFromDisk(memory, job);
      if (chosen === job) await reapIfOwnerGone(chosen);
      noteRevision(chosen);
      sequenceJobs.set(chosen.id, chosen);
    } catch {
      // One unreadable file must not stop the others from loading.
    }
  }
}

export async function loadJobsFromDisk() {
  await sweepOrphanTemps(JOBS_DIR);
  await sweepStaleReviewFrames(JOBS_DIR);
  await refreshJobsFromDisk();
}

async function readClaimFile(path: string): Promise<JobOwner | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as JobOwner;
    if (typeof parsed?.pid !== "number" || typeof parsed.token !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function readClaim(jobId: string): Promise<JobOwner | undefined> {
  return readClaimFile(claimPath(jobId));
}

async function claimFileAge(jobId: string): Promise<number | undefined> {
  try {
    const info = await stat(claimPath(jobId));
    return Date.now() - info.mtimeMs;
  } catch {
    return undefined;
  }
}

/** A missing owner is an empty or broken claim. Those are stale only after a short grace, so a writer can finish. */
function claimIsStale(owner: JobOwner | undefined, ageMs: number | undefined): boolean {
  if (!owner) return ageMs === undefined || ageMs > CLAIM_EMPTY_GRACE_MS;
  return jobShouldStop(owner);
}

/** Publish a complete claim file. Only one caller can create the path. */
async function placeClaim(jobId: string, owner: JobOwner): Promise<boolean> {
  return publishExclusive(claimPath(jobId), JSON.stringify(owner));
}

type ClaimTurn = { pid: number; token: string; host: string; at: number };

function claimTurnPath(jobId: string): string {
  return `${claimPath(jobId)}.turn`;
}

async function readClaimTurn(path: string): Promise<ClaimTurn | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as Partial<ClaimTurn>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return undefined;
    return {
      pid: parsed.pid,
      token: parsed.token,
      host: typeof parsed.host === "string" ? parsed.host : "",
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return undefined;
  }
}

/** A live process's turn is kept. An empty turn, or one whose pid is gone, is stale after a short grace. */
const activeClaimTurns = new Set<string>();

function claimTurnIsStale(info: ClaimTurn | undefined, ageMs: number | undefined): boolean {
  if (!info) return ageMs === undefined || ageMs > CLAIM_EMPTY_GRACE_MS;
  if (ageMs !== undefined && ageMs <= CLAIM_EMPTY_GRACE_MS) return false;
  if (info.host === processHost && info.pid === process.pid && activeClaimTurns.has(info.token)) return false;
  if (info.host === processHost && info.pid === process.pid) return true;
  if (info.host === processHost && !pidAlive(info.pid)) return true;
  return ageMs !== undefined && ageMs > 15_000;
}

/**
 * Move `path` aside and delete it only when the bytes are still `expected`.
 * Anything else is put back if the slot is empty, and never overwritten.
 */
async function discardIfUnchanged(path: string, expected: string): Promise<boolean> {
  const tomb = `${path}.tomb.${randomUUID()}`;
  try {
    await rename(path, tomb);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  let tombRaw = "";
  try {
    tombRaw = await readFile(tomb, "utf8");
  } catch {
    tombRaw = "";
  }
  if (tombRaw !== expected) {
    await restoreIfAbsent(tomb, path);
    return false;
  }
  let tombAge: number | undefined;
  try {
    tombAge = Date.now() - (await stat(tomb)).mtimeMs;
  } catch {
    tombAge = undefined;
  }
  if (!tombRaw.trim() && !(tombAge !== undefined && tombAge > CLAIM_EMPTY_GRACE_MS)) {
    await restoreIfAbsent(tomb, path);
    return false;
  }
  await unlink(tomb).catch(() => undefined);
  return true;
}

async function acquireClaimTurn(jobId: string): Promise<string | undefined> {
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, token, host: processHost, at: Date.now() } satisfies ClaimTurn);
  const dest = claimTurnPath(jobId);
  if (await publishExclusive(dest, body)) {
    activeClaimTurns.add(token);
    return token;
  }
  let turnAge: number | undefined;
  try {
    turnAge = Date.now() - (await stat(dest)).mtimeMs;
  } catch {
    return undefined;
  }
  const current = await readClaimTurn(dest);
  if (!claimTurnIsStale(current, turnAge)) return undefined;
  let raw = "";
  try {
    raw = await readFile(dest, "utf8");
  } catch {
    return undefined;
  }
  if (!await discardIfUnchanged(dest, raw)) return undefined;
  if (await publishExclusive(dest, body)) {
    activeClaimTurns.add(token);
    return token;
  }
  return undefined;
}

async function releaseClaimTurn(jobId: string, token: string): Promise<void> {
  activeClaimTurns.delete(token);
  const dest = claimTurnPath(jobId);
  const current = await readClaimTurn(dest);
  if (current?.token !== token) return;
  let raw = "";
  try {
    raw = await readFile(dest, "utf8");
  } catch {
    return;
  }
  if (!raw.includes(token)) return;
  await discardIfUnchanged(dest, raw);
}

/**
 * Exclusive on-disk claim for a film about to be resumed or repaired.
 * A live owner blocks the second caller. Replacing a stale claim happens
 * only while this process holds the turn file, and only if the bytes moved
 * aside are still the stale bytes we decided to replace.
 */
/**
 * The claim file is already ours. Read the job JSON again and write only that
 * copy plus the claim, so a snapshot taken before the claim cannot overwrite
 * the other process's annotation.
 */
async function commitClaimFromDisk(jobId: string, owner: JobOwner): Promise<boolean> {
  const disk = await readPersistedJob(jobId);
  if (!disk) return false;
  noteRevision(disk);
  disk.claim = owner;
  sequenceJobs.set(jobId, disk);
  await persistJob(disk);
  return true;
}

/**
 * Test seam. Unset in production. A probe runs after this process has read the
 * film and before it takes the claim, which is the window a stale snapshot would
 * overwrite.
 */
let beforeClaimProbe: ((jobId: string) => Promise<void>) | undefined;

export function setBeforeClaimProbe(next: ((jobId: string) => Promise<void>) | undefined): void {
  beforeClaimProbe = next;
}

export async function claimFilm(jobId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await refreshJobsFromDisk();
  const job = sequenceJobs.get(jobId);
  if (!job) return { ok: false, message: "Unknown job" };
  if (job.state === "running" && otherProcessHolds(job.owner)) {
    return { ok: false, message: ALREADY_RUNNING };
  }
  if (job.claim && !jobShouldStop(job.claim)) {
    return { ok: false, message: claimBusyMessage(job.claim) };
  }
  // The in-memory film is from before this wait. commitClaimFromDisk re-reads
  // so a note written while we wait is not overwritten by that snapshot.
  if (beforeClaimProbe) await beforeClaimProbe(jobId);

  for (let attempt = 0; attempt < 40; attempt++) {
    const age = await claimFileAge(jobId);
    const existing = age === undefined ? undefined : await readClaim(jobId);
    if (age !== undefined && !claimIsStale(existing, age)) {
      return { ok: false, message: claimBusyMessage(existing) };
    }
    const turn = await acquireClaimTurn(jobId);
    if (!turn) {
      await sleep(10 + attempt);
      continue;
    }
    try {
      const heldAge = await claimFileAge(jobId);
      const held = heldAge === undefined ? undefined : await readClaim(jobId);
      if (heldAge !== undefined && !claimIsStale(held, heldAge)) {
        return { ok: false, message: claimBusyMessage(held) };
      }
      const owner = thisOwner();
      if (heldAge === undefined) {
        if (await placeClaim(jobId, owner)) {
          if (await commitClaimFromDisk(jobId, owner)) return { ok: true };
          await unlink(claimPath(jobId)).catch(() => undefined);
        }
        continue;
      }
      let raw = "";
      try {
        raw = await readFile(claimPath(jobId), "utf8");
      } catch {
        if (await placeClaim(jobId, owner)) {
          if (await commitClaimFromDisk(jobId, owner)) return { ok: true };
          await unlink(claimPath(jobId)).catch(() => undefined);
        }
        continue;
      }
      if (!await discardIfUnchanged(claimPath(jobId), raw)) continue;
      if (!await placeClaim(jobId, owner)) continue;
      if (await commitClaimFromDisk(jobId, owner)) return { ok: true };
      await unlink(claimPath(jobId)).catch(() => undefined);
      continue;
    } finally {
      await releaseClaimTurn(jobId, turn);
    }
  }
  if (await liveTurnWithoutClaim(jobId)) {
    return { ok: false, message: TAKING_OVER };
  }
  return { ok: false, message: ALREADY_RUNNING };
}

/** A turn file younger than its expiry, with no live claim beside it. */
async function liveTurnWithoutClaim(jobId: string): Promise<boolean> {
  const dest = claimTurnPath(jobId);
  let turnAge: number | undefined;
  try {
    turnAge = Date.now() - (await stat(dest)).mtimeMs;
  } catch {
    return false;
  }
  const turn = await readClaimTurn(dest);
  if (!turn || claimTurnIsStale(turn, turnAge)) return false;
  const age = await claimFileAge(jobId);
  const existing = age === undefined ? undefined : await readClaim(jobId);
  return age === undefined || claimIsStale(existing, age);
}

export async function readPersistedJob(jobId: string): Promise<SequenceJob | undefined> {
  try {
    const raw = await readFile(join(JOBS_DIR, `${jobId}.json`), "utf8");
    const job = JSON.parse(raw) as SequenceJob;
    if (!job || job.id !== jobId) return undefined;
    return job;
  } catch {
    return undefined;
  }
}

export function rememberedJob(jobId: string): SequenceJob | undefined {
  return sequenceJobs.get(jobId);
}

/**
 * Write one optional Phase 1 field onto a finished film.
 * A running render is left alone. The claim is released before this returns.
 */
export const CLAIM_CONTENTION = "Another process is writing this film; retry shortly.";

export async function saveJobAnnotation(
  jobId: string,
  patch: (job: SequenceJob) => void,
): Promise<{ ok: true; job: SequenceJob } | { ok: false; message: string }> {
  await refreshJobsFromDisk();
  const existing = sequenceJobs.get(jobId);
  if (!existing) return { ok: false, message: "Unknown job" };
  if (existing.state === "running") {
    return {
      ok: false,
      message: "This film is rendering. The note was not written and the render was not stopped.",
    };
  }
  const claim = await claimFilm(jobId);
  if (!claim.ok) {
    const latest = sequenceJobs.get(jobId);
    if (latest && latest.state !== "running") {
      return { ok: false, message: CLAIM_CONTENTION };
    }
    return claim;
  }
  try {
    const disk = await readPersistedJob(jobId);
    if (!disk) return { ok: false, message: "Unknown job" };
    if (disk.state === "running") {
      return {
        ok: false,
        message: "This film is rendering. The note was not written and the render was not stopped.",
      };
    }
    const held = sequenceJobs.get(jobId)?.claim;
    noteRevision(disk);
    const fresh: SequenceJob = { ...disk, claim: held };
    sequenceJobs.set(jobId, fresh);
    patch(fresh);
    await persistJob(fresh);
    return { ok: true, job: fresh };
  } finally {
    await releaseFilmClaim(jobId);
  }
}

export async function releaseFilmClaim(jobId: string): Promise<void> {
  const disk = await readPersistedJob(jobId);
  const memory = sequenceJobs.get(jobId);
  const job = disk ?? memory;
  if (!job) {
    await unlink(claimPath(jobId)).catch(() => undefined);
    return;
  }
  if ((disk?.claim?.token ?? memory?.claim?.token) !== processToken && memory?.claim?.token !== processToken) {
    await unlink(claimPath(jobId)).catch(() => undefined);
    return;
  }
  noteRevision(job);
  job.claim = undefined;
  sequenceJobs.set(jobId, job);
  await persistJob(job);
}

function sequenceJobId(): string {
  return `seq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function jobPayload(job: SequenceJob) {
  const done = job.state !== "running";
  return {
    jobId: job.id,
    state: job.state,
    progress: `${job.completed}/${job.shotCount} shots`,
    done,
    ...(done ? {
      spentUsd: Math.round(job.spentUsd * 100) / 100,
      estimatedUsd: job.estimateUsd,
      // Carried shots were paid for by an earlier run. Show the whole film's
      // cost and this run's cost separately so neither number lies.
      ...(job.carriedOverUsd !== undefined ? {
        carriedOverUsd: job.carriedOverUsd,
        filmTotalUsd: Math.round((job.spentUsd + job.carriedOverUsd) * 100) / 100,
        continuedFrom: job.resumedFrom,
      } : {}),
      ...(job.repairedFrom ? {
        repairedShot: job.repairedFrom,
        // What the film actually cost, counting the shot that was replaced. The
        // difference between this and filmTotalUsd is money spent and thrown away.
        filmSpentIncludingReplacedUsd: Math.round(
          (job.spentUsd + (job.carriedOverUsd ?? 0) + (job.repairedFrom.originalCostUsd ?? 0)) * 100,
        ) / 100,
      } : {}),
      shots: job.shots,
      filmPath: job.filmPath,
      fileUrl: job.fileUrl,
      filmDurationSeconds: job.filmDurationSeconds,
      filmBytes: job.filmBytes,
      lastFramePath: job.lastFramePath,
      unknownCharacters: job.unknownCharacters?.length ? job.unknownCharacters : undefined,
      warnings: job.warnings?.length ? job.warnings : undefined,
      error: job.error,
      ledger: job.ledger,
      ...(job.continuityReview ? { continuityReview: job.continuityReview } : {}),
      ...(job.spendLedger ? { spendLedger: job.spendLedger } : {}),
      ...(job.dependencies ? { dependencies: job.dependencies } : {}),
      ...(job.repairProposal ? { repairProposal: job.repairProposal } : {}),
    } : {
      spentUsdSoFar: Math.round(job.spentUsd * 100) / 100,
      message: "Still rendering. Poll check_sequence with this jobId.",
    }),
    next: job.state === "completed"
      ? "Report the filmPath and spentUsd to the user, and repeat any warnings verbatim: they say " +
        "which shots are now inconsistent. To make the film longer, call render_sequence again " +
        "with resumeFromJobId set to this jobId and only the new shots."
      : job.state === "running"
        ? "Poll check_sequence every 20 to 30 seconds. Do not start a second render of the same shots."
        : "Report the error and the shot that failed. Any shots already rendered are still on " +
          "disk and can be assembled or continued from.",
  };
}

/**
 * Run the chain in the background on the already-downloaded clips. Writes into
 * the job so a poll sees progress as each shot lands.
 */
async function runSequenceJob(
  job: SequenceJob,
  args: {
    shots: Array<{
      prompt: string;
      durationSeconds: number;
      title?: string;
      /** Explicit opening frame for this shot. Overrides chaining. */
      firstFrameUrl?: string;
      /** Pinned closing frame, which makes this shot a bookend. */
      lastFrameUrl?: string;
      faceAnchor?: "auto" | "off";
      shotType?: string;
      negative?: string;
      admission?: TakeReport;
    }>;
    characters?: string[];
    continuity?: string;
    firstFrameUrl?: string;
    aspectRatio: string;
    resolution: string;
    model: string;
    assemble: boolean;
    fadeDuration: number;
    audioTrackFile?: string;
    audioTrackVolume?: number;
    audioTrackFadeOutSeconds?: number;
    clipAudio?: "keep" | "mute" | "replace";
    pin?: "start" | "both";
    voiceId?: string;
    timeoutSecondsPerShot: number;
    /**
     * Shots already rendered by an earlier job, in order, kept on the front of
     * the film. Their clips go into the final assembly so continuing a film
     * assembles the whole thing instead of just the tail.
     */
    carriedShots?: SequenceJob["shots"];
    /**
     * Shots reused verbatim after the ones being rendered. This is how a single
     * repaired shot is spliced back in: everything before it is carried, it is
     * re-rendered, and everything after it is kept as it was.
     */
    trailingShots?: SequenceJob["shots"];
    /** Frame to chain the first new shot from, when resuming mid-film. */
    resumeFramePath?: string;
  },
) {
  const characterRefs: string[] = [];
  for (const name of args.characters ?? []) {
    const known = lookupCharacter(name);
    if (!known) { (job.unknownCharacters ??= []).push(name); continue; }
    characterRefs.push(...(known.referenceImageUrls ?? []));
  }
  const portraitRefs = await withPersonCutouts(args.characters, Array.from(new Set(characterRefs)));

  // Carried shots render nothing and cost nothing; they are here so the film
  // assembles complete and so shot numbering stays honest in the progress view.
  const carried = args.carriedShots ?? [];
  const trailing = args.trailingShots ?? [];
  job.shots.push(...carried);
  job.completed = carried.length;

  let previousFrame: string | undefined =
    args.resumeFramePath ?? carried.at(-1)?.framePath ?? args.firstFrameUrl;
  if (previousFrame) job.lastFramePath = previousFrame;

  /** Things that still made a film, but not the film that was asked for. */
  const degradations: string[] = [];
  try {
    for (let i = 0; i < args.shots.length; i++) {
      const shot = args.shots[i];
      // Explicit frames beat chaining. A boarded shot already knows both of its
      // ends; chaining it from the previous render would quietly replace the
      // frame the user approved with a slightly different picture, and the join
      // that was supposed to land on identical pixels would drift instead.
      const shotFirstFrame = shot.firstFrameUrl ?? previousFrame;
      // A face drifts most when the prompt never mentions the person: the clip
      // is pinned at both ends but nothing in the text says whose face it is
      // holding, so the sampler reshapes it as the action plays out. Measured
      // over six 6-second clips between the same two stills, adding one short
      // sentence raised the worst sampled face-identity cosine from 0.391 to
      // 0.442 and the mean from 0.601 to 0.684. A longer, more insistent
      // version of the same instruction scored WORSE (worst 0.219, mean 0.547),
      // which is why this is one clause and not a paragraph. It says "the face",
      // not "his face": measured equally well (0.500/0.639 against 0.516/0.598)
      // and it is not safe to assume everyone on screen is a man.
      const prompt = composeShotPrompt(args.continuity, shot.prompt);
      const anchored = mentionsPerson(prompt) && shouldAnchorFace(prompt, {
        faceAnchor: shot.faceAnchor,
        shotType: shot.shotType,
      })
        ? `${prompt} Keep the face exactly as the first frame shows it.`
        : prompt;
      const renderShot = () => generateGrokClip({
        prompt: anchored,
        durationSeconds: shot.durationSeconds,
        aspectRatio: args.aspectRatio as "16:9" | "9:16" | "1:1",
        resolution: args.resolution,
        model: args.model,
        firstFrameUrl: shotFirstFrame,
        lastFrameUrl: shot.lastFrameUrl,
        pin: args.pin ?? "start",
        voiceId: args.voiceId,
        negative: shot.negative,
        admission: shot.admission,
        referenceImageUrls: portraitRefs.length > 0 ? portraitRefs : undefined,
      }, { waitForCompletion: true, timeoutSeconds: args.timeoutSecondsPerShot });
      // Retry an API failure it owns, then degrade rather than stop the film.
      //
      // A render with `last_frame` pinned fails intermittently with "Video
      // generation failed due to an internal error. Please try again." - and
      // it means it. Measured on one shot's frames in one bad window:
      // first-frame-only completed 4 of 4, last-frame-only 2 of 4, and the
      // bookend both at once 1 of 4. An hour later the same three shapes each
      // completed first time, so this is a bad window on the proxy rather than
      // a broken request: the rate is not a fixed property of the API and
      // should never be quoted as one.
      //
      // A failed render is not billed, so retrying costs nothing but time. In
      // that bad window three retries took one shot of four from a stopped film
      // to a hard cut, and every shot rendered in the good windows needed none.
      //
      // If it still will not take the closing frame, the shot renders from its
      // first frame alone and says so. That trades a chained join for a hard cut
      // on ONE seam - visible, reported, and far better than a stopped chain
      // where the rest of the film was never made.
      let result = await renderShot();
      let retries = 0;
      while (result.status === "failed" && result.retryable && retries < 3) {
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 2500 * retries));
        result = await renderShot();
      }
      if (result.status === "failed" && result.retryable && shot.lastFrameUrl) {
        result = await generateGrokClip({
          prompt: anchored,
          durationSeconds: shot.durationSeconds,
          aspectRatio: args.aspectRatio as "16:9" | "9:16" | "1:1",
          resolution: args.resolution,
          model: args.model,
          firstFrameUrl: shotFirstFrame,
          pin: "start",
          voiceId: args.voiceId,
          negative: shot.negative,
          admission: shot.admission,
          referenceImageUrls: portraitRefs.length > 0 ? portraitRefs : undefined,
        }, { waitForCompletion: true, timeoutSeconds: args.timeoutSecondsPerShot });
        if (result.status === "completed") {
          degradations.push(
            `Shot ${carried.length + i + 1} rendered without its closing frame after the API ` +
            `refused it four times: that seam is a cut rather than a chained join.`,
          );
        }
      }

      const shotNumber = carried.length + i + 1;
      const entry = {
        index: shotNumber,
        title: shot.title ?? `Shot ${shotNumber}`,
        status: result.status ?? "failed",
        videoUrl: result.videoUrl,
        costUsd: result.costUsd,
        error: result.error,
        localPath: undefined as string | undefined,
        framePath: undefined as string | undefined,
        openingFramePath: shotFirstFrame,
        pinUsed: args.pin ?? "start",
        lastFrameUrl: shot.lastFrameUrl,
        lastFramePath: localImagePath(shot.lastFrameUrl),
        closingFrameAgreement: undefined as number | undefined,
        prompt: shot.prompt,
        sentPrompt: anchored,
        durationSeconds: shot.durationSeconds,
        ...(shot.shotType?.trim() ? { shotType: shot.shotType.trim() } : {}),
      };
      const quotedShot = Math.round(shot.durationSeconds * ratePerSecond(args.resolution) * 100) / 100;
      const shotCharge = chargeForProviderResult(result, quotedShot);
      entry.costUsd = shotCharge.record ? shotCharge.usd : result.costUsd;
      if (shotCharge.record) {
        job.spentUsd += shotCharge.usd;
        noteReportedSpend(job, "video", shotCharge.usd, {
          estimated: shotCharge.estimated,
          uncertain: shotCharge.uncertain,
          reason: shotCharge.reason,
        });
      }
      job.shots.push(entry);

      if (result.status !== "completed" || !result.videoUrl) {
        job.state = "stopped";
        job.error = `Shot ${shotNumber} failed: ${result.error ?? "no video URL returned"}. The chain stopped so no later shot renders without continuity.`;
        job.finishedAt = Date.now();
        await persistJob(job);
        await waitForJobEvents(job.id);
        return;
      }

      const clipPath = await resolveToLocalFile(result.videoUrl);
      entry.localPath = clipPath;

      // Did it actually arrive where it was pinned? A `completed` poll only says
      // the proxy made a video, not that it honoured the closing frame, and the
      // one case where it did not was billed like any other. Measure, because
      // the next shot chains from whatever this clip really ended on and a
      // silent miss shows up later as the cast having changed.
      const pinnedClose = localImagePath(shot.lastFrameUrl);
      if (pinnedClose) {
        const agreement = await closingFrameAgreement({ clip: clipPath, frame: pinnedClose });
        if (agreement !== undefined) {
          entry.closingFrameAgreement = agreement;
          if (agreement < CLOSING_FRAME_MATCH_THRESHOLD) {
            degradations.push(
              `Shot ${shotNumber} was given a closing frame and ended somewhere else ` +
                `(match ${agreement.toFixed(2)} of 1.00), so the next shot opens on the boarded ` +
                "frame while this one closes elsewhere: that seam is a jump, not a chained join.",
            );
          }
        }
      }

      const frame = await extractLastFrame({ file: clipPath });
      if (!frame.path) {
        job.state = "stopped";
        job.error = `Shot ${shotNumber} rendered but its last frame could not be extracted, so the chain has no anchor for the next shot.`;
        job.finishedAt = Date.now();
        await persistJob(job);
        await waitForJobEvents(job.id);
        return;
      }
      const accepted = await acceptRenderedTake(frame.path, shot.admission, shot.negative);
      if (!accepted.ok) {
        await acceptRenderedTake(clipPath, shot.admission, shot.negative);
        entry.localPath = undefined;
        entry.framePath = undefined;
        entry.status = "failed";
        entry.error =
          `Admission failed: ${accepted.failures.join("; ")}. ` +
          "The take was discarded and is not the next start frame.";
        job.state = "stopped";
        job.error = entry.error;
        job.finishedAt = Date.now();
        await persistJob(job);
        await waitForJobEvents(job.id);
        return;
      }
      previousFrame = frame.path;
      entry.framePath = frame.path;
      job.lastFramePath = frame.path;
      job.completed = shotNumber;
      // Paid for, so on disk: a crash between shots keeps everything bought.
      void persistJob(job);
    }

    // Reused shots go on last and change nothing. They are already paid for.
    if (trailing.length > 0) {
      job.shots.push(...trailing);
      job.completed += trailing.length;
      job.lastFramePath = trailing.at(-1)?.framePath ?? job.lastFramePath;
    }

    if (args.assemble) {
      const files = job.shots
        .map((shot) => shot.localPath)
        .filter((p): p is string => Boolean(p))
        .map((file) => ({ file: file as string, trimStart: undefined, trimEnd: undefined }));
      const assembled = await assembleClips({
        clips: files,
        fadeDuration: args.fadeDuration,
        audioTrackFile: args.audioTrackFile,
        audioTrackVolume: args.audioTrackVolume,
        audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
        clipAudio: args.clipAudio,
      });
      job.filmPath = assembled.path;
      job.fileUrl = `file://${assembled.path}`;
      job.filmDurationSeconds = await probeDuration(assembled.path);
      job.filmBytes = (await (await import("node:fs/promises")).stat(assembled.path)).size;
    }

    job.state = "completed";
    job.finishedAt = Date.now();
    if (degradations.length > 0) {
      // A film that exists but is not quite the one that was asked for must say
      // so, or the seam reads as a bug the user has to hunt for.
      job.warnings = [...(job.warnings ?? []), ...degradations];
    }
    await persistJob(job);
    await waitForJobEvents(job.id);
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    await persistJob(job);
    await waitForJobEvents(job.id);
  }
}

server.registerTool(
  "render_sequence",
  {
    description:
      "Render a multi-shot sequence with automatic continuity: each shot starts from the previous " +
      "shot's last frame, so faces, wardrobe, lighting, and set carry through the whole film. " +
      "Optionally assembles the result into one film. This is how you make something longer than a " +
      "single 15-second clip. Spends real money per shot, so call once without confirm for an " +
      "estimate and only pass confirm after the user approves it. Returns a jobId immediately; a " +
      "long sequence keeps running, so poll check_sequence for the film rather than re-rendering.",
    inputSchema: z.object({
      shots: z.array(z.object({
        prompt: z.string().describe(
          "Everything the model must show in this shot. It has no memory between shots, so repeat " +
          "wardrobe, lighting, and set details in every entry.",
        ),
        durationSeconds: z.number().min(1).max(15).default(8),
        title: z.string().optional(),
        firstFrameUrl: z.string().optional().describe(
          "Explicit opening frame for this shot: an https URL, a data URI, or a local path such " +
          "as a still from board_film. Overrides chaining from the previous shot, so a boarded " +
          "shot renders from the frame the user actually approved.",
        ),
        lastFrameUrl: z.string().optional().describe(
          "Pinned closing frame for this shot. Used only when pin is \"both\". The default pin is " +
          "the start frame, because an end pin makes the model hold.",
        ),
        locationId: z.string().optional(),
        shotType: z.string().optional(),
        faceAnchor: z.enum(["auto", "off"]).optional(),
        negative: z.string().optional(),
        admission: TakeAdmissionSchema.optional(),
      })).min(1).max(12).describe("Shots in order, 1 to 12. More than that is usually two films."),
      characters: z.array(z.string()).optional().describe(
        "Character names from create_character. Their reference images go on every shot.",
      ),
      continuity: z.string().optional().describe(
        "Set, wardrobe, light, and palette, written once and prepended to every shot.",
      ),
      ledger: z.object({
        locations: z.array(LocationSchema).optional(),
        props: z.array(PropRecordSchema).optional(),
        wardrobeEvents: z.array(WardrobeEventSchema).optional(),
        propEvents: z.array(PropEventSchema).optional(),
        shots: z.array(z.any()).optional(),
        shotSteps: z.array(z.object({
          shot: z.number().int().min(1),
          steps: z.array(z.string()),
        })).optional(),
        voiceId: z.string().optional(),
        promptStyle: z.enum(["legacy", "sections-v2"]).optional(),
        spokenLines: z.array(z.object({
          shot: z.number().int().min(1),
          line: z.string(),
        })).optional(),
        humanVisionSignOff: z.boolean().optional(),
        hasPortrait: z.boolean().optional(),
        scaleMarks: z.array(z.object({
          shot: z.number().int().min(1),
          bodyH: z.number(),
          tolPct: z.number(),
          measuredBodyH: z.number().optional(),
        })).optional(),
        bodyClearance: z.array(z.object({
          shot: z.number().int().min(1),
          solidId: z.string(),
          clear: z.boolean(),
        })).optional(),
        tier1: z.object({
          freezeRun: z.number(),
          speechCoverage: z.number(),
          joinSsim: z.number(),
          motionNatural: z.number(),
        }).optional(),
      }).optional().describe(
        "Prop ledger and wardrobe events from plan_storyboard. Stored on the job so a resumed " +
        "film keeps the same rooms and props. Does not by itself spend money or call vision.",
      ),
      contracts: z.array(ShotContractSchema).optional().describe(
        "Optional per-shot state-file contracts. When omitted they are derived from ledger.",
      ),
      overrideValidation: z.boolean().default(false).describe(
        "When true, start the render even if the shot contracts fail validation. The default " +
        "is to refuse rather than spend on a plan the ledger already knows is inconsistent.",
      ),
      firstFrameUrl: z.string().optional().describe(
        "Optional anchor for shot one: a portrait or location still, or a previous film's last frame.",
      ),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("720p").describe(
        "Output resolution. 1080p costs roughly twice 720p per second of video.",
      ),
      model: z.string().default("grok-imagine-video-1.5"),
      assemble: z.boolean().default(true).describe("Also assemble the clips into one film."),
      audioTrackUrl: z.string().optional().describe(
        "Optional music, narration or ambience for the finished film, mixed under the clips' own " +
        "audio. https URL, file:// URL, or a local path such as a chat attachment.",
      ),
      audioTrackVolume: z.number().min(0).max(4).default(0.25),
      clipAudio: z.enum(["keep", "mute", "replace"]).default("keep").describe(
        "keep mixes clip audio. mute drops it. replace uses only the bed.",
      ),
      pin: z.enum(["start", "both"]).default("start").describe(
        "start pins each shot's first frame only. both also sends lastFrameUrl.",
      ),
      voiceId: z.string().optional().describe("Built-in voice id, such as rex."),
      promptStyle: z.enum(["legacy", "sections-v2"]).optional().describe(
        "sections-v2 refuses a voiced shot whose prompt has no <AUDIO_0>. The default only warns.",
      ),
      audioTrackFadeOutSeconds: z.number().min(0).max(30).default(1.5),
      fadeDuration: z.number().min(0).max(5).default(0).describe(
        "Seconds of cross-fade at each join. 0 (the default) is a hard cut, which is right whenever " +
        "the shot changes framing: sharp, and it reads as an edit. Raise it to 0.15-0.3 only when " +
        "consecutive shots continue one camera move with the same framing, where a cut would pop. " +
        "A dissolve between drifted textures double-exposes and softens the image for its length.",
      ),
      resumeFromJobId: z.string().optional().describe(
        "Continue an earlier render_sequence job instead of starting a new film. Shots it " +
        "already rendered are kept, cost nothing more, and go into the final assembly; the " +
        "shots you pass here are appended after them and chain from the last rendered frame. " +
        "This is how a film goes past 12 shots.",
      ),
      confirm: z.boolean().default(false).describe(
        "Must be true to render. Call once without it to get the estimate, show it to the user, and " +
        "call again with true only after they approve.",
      ),
      timeoutSecondsPerShot: z.number().min(10).max(600).default(240),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    const shotCount = args.shots.length;
    const totalSeconds = args.shots.reduce((sum, s) => sum + s.durationSeconds, 0);

    // Resolve a resume target up front so a bad id fails before anything spends.
    let resumeJob: SequenceJob | undefined;
    if (args.resumeFromJobId) {
      await refreshJobsFromDisk();
      resumeJob = sequenceJobs.get(args.resumeFromJobId);
      if (!resumeJob) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Unknown resumeFromJobId",
              detail:
              "No film has that id. Call list_films to see every film on disk with its job id.",
              known: Array.from(sequenceJobs.keys()).slice(-5),
            }, null, 2),
          }],
        };
      }
      if (otherProcessHolds(resumeJob.owner) || otherProcessHolds(resumeJob.claim)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: ALREADY_RUNNING,
              detail: "Another process already claimed this film. Wait for it to finish, then check_sequence or list_films.",
              jobId: resumeJob.id,
            }, null, 2),
          }],
        };
      }
      if (resumeJob.state === "running") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "That job is still running",
              detail: "Wait for it to finish and poll check_sequence. Continuing a running job renders it twice.",
              jobId: resumeJob.id,
            }, null, 2),
          }],
        };
      }
      if (resumeJob.shots.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "That job rendered no shots to continue from",
              jobId: resumeJob.id,
              state: resumeJob.state,
              detail: resumeJob.error ?? "Start a new film with firstFrameUrl instead.",
            }, null, 2),
          }],
        };
      }
    }

    const carried = resumeJob ? resumeJob.shots.filter((s) => s.localPath) : [];
    const resumeFramePath = carried.at(-1)?.framePath;

    // An explicit first frame on the new shot wins over chaining, so check the
    // join that will actually be made rather than the one the old film implies.
    const continuationStartFrame = args.shots[0]?.firstFrameUrl ?? resumeFramePath;

    // Measured on real renders, 8 seconds each: 480p billed 0.64, 720p billed
    // 1.12, 1080p billed 2.00. The old flat 8 cents per second was only ever the
    // 480p rate, which is also the soft 848x480 default, so every earlier estimate
    // was quietly quoting the cheapest and worst-looking setting.
    const estimate = Math.round(
      args.shots.reduce((sum, s) => sum + s.durationSeconds * ratePerSecond(args.resolution), 0) * 100,
    ) / 100;
    const sequenceQuote = videoQuote({
      resolution: args.resolution,
      pin: args.pin ?? "start",
      durations: args.shots.map((shot) => shot.durationSeconds),
      prompts: args.shots.map((shot) => shot.prompt),
      continuity: args.continuity,
      model: args.model,
      aspectRatio: args.aspectRatio,
      firstFrames: args.shots.map((shot) => shot.firstFrameUrl),
      lastFrames: args.shots.map((shot) => shot.lastFrameUrl),
    });
    const sequenceBudget = args.budgetUsd ?? resumeJob?.spendLedger?.thresholdUsd;
    const sequencePaid = await quoteGate(
      { ...args, budgetUsd: sequenceBudget },
      "video",
      estimate,
      sequenceQuote.fingerprint,
      resumeJob,
    );
    const sequenceCostRefusal = costRefusal(sequencePaid);
    if (sequenceCostRefusal) return sequenceCostRefusal;

    // A resumed film is the one place a stale cast hides, because the shots it
    // joins to were paid for in an earlier session and cannot be re-checked by
    // eye. If the new shots open on a boarded frame that is not the picture the
    // old film ended on, the join is a cut between two different cast members.
    // Say so before spending, rather than discovering it in the finished film.
    const resumeWarnings: string[] = [];
    if (resumeJob && continuationStartFrame) {
      const oldEnd = carried.at(-1)?.framePath;
      if (oldEnd && continuationStartFrame !== oldEnd) {
        resumeWarnings.push(
          "The new shot does not start on the frame the earlier film ends on. It will join " +
            `the old film at ${oldEnd} but render from ${continuationStartFrame}, so the cut ` +
            "between them is an unpinned join and the cast may change across it. Either pass " +
            "firstFrameUrl identical to the old film's last frame, or start a new film.",
        );
      }
    }

    const bookendedShots = args.shots.filter((s) => s.lastFrameUrl).length;
    // A boarded film's boundary frame is one picture used twice. Counting how
    // many joins are pinned is the honest way to say whether the cuts will land
    // on identical pixels, and it is what makes a board reportable before render.
    const sharedBoundaries = args.shots.reduce((count, shot, i) => {
      const next = args.shots[i + 1];
      return next && shot.lastFrameUrl && shot.lastFrameUrl === next.firstFrameUrl
        ? count + 1
        : count;
    }, 0);

    const storedLedger = resumeJob?.ledger;
    const carriedStyle = args.promptStyle ?? args.ledger?.promptStyle ?? storedLedger?.promptStyle;
    const carriedVoice = args.voiceId ?? args.ledger?.voiceId ?? storedLedger?.voiceId;
    const ledgerForGate = args.ledger
      ? {
          ...args.ledger,
          ...(carriedStyle ? { promptStyle: carriedStyle } : {}),
          ...(carriedVoice ? { voiceId: carriedVoice } : {}),
        }
      : storedLedger
      ? {
          locations: storedLedger.locations,
          props: storedLedger.props,
          wardrobeEvents: storedLedger.wardrobeEvents,
          propEvents: storedLedger.propEvents,
          shotSteps: storedLedger.shotSteps,
          voiceId: carriedVoice,
          promptStyle: carriedStyle,
          spokenLines: storedLedger.spokenLines,
          humanVisionSignOff: storedLedger.humanVisionSignOff,
          hasPortrait: storedLedger.hasPortrait,
          scaleMarks: storedLedger.scaleMarks,
          bodyClearance: storedLedger.bodyClearance,
          tier1: storedLedger.tier1,
        }
      : undefined;
    const continuityPlan = continuityPlanFromRenderArgs({
      shots: args.shots,
      characters: args.characters,
      promptStyle: carriedStyle,
      ledger: ledgerForGate
        ? {
            ...ledgerForGate,
            ...(carriedVoice ? { voiceId: carriedVoice } : {}),
            ...(carriedStyle ? { promptStyle: carriedStyle } : {}),
          }
        : undefined,
    });
    const contractGate = gateRenderSequence({
      plan: continuityPlan,
      contracts: args.contracts as ShotContract[] | undefined,
      overrideValidation: args.overrideValidation,
    });

    if (args.confirm && contractGate.blocked) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "refused",
            error: RENDER_BLOCKED_BY_CONTRACT,
            message: contractGate.message,
            violations: contractGate.violations,
            contractValidation: contractGate,
          }, null, 2),
        }],
      };
    }

    const outgoing = sequenceContractShots({
      shots: args.shots,
      continuity: args.continuity,
      resolution: args.resolution,
      pin: args.pin ?? "start",
      voiceId: carriedVoice,
    });
    const lintBlocked = outgoing.some((shot) => shot.lintHits.length > 0);

    if (!args.confirm) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "estimate-only",
            willRender: false,
            plan: {
              shots: shotCount,
              totalSeconds,
              aspectRatio: args.aspectRatio,
              resolution: args.resolution,
              fadeSeconds: args.fadeDuration,
              continuity: (args.pin ?? "start") === "both" && bookendedShots > 0
                ? `${bookendedShots} of ${shotCount} shots pin both the opening frame and the closing frame.`
                : bookendedShots > 0
                  ? `${bookendedShots} of ${shotCount} shots include a closing frame, but pin is "start", ` +
                    "so those closing frames are not sent and the cuts are not pixel-pinned. Pass " +
                    "pin: \"both\" to send them. The default stays start."
                  : "Each shot starts from the previous shot's last frame. Closing frames are not pinned.",
              bookendedShots,
              sharedBoundaryFrames: sharedBoundaries,
              rendersAsOneJob: true,
              ...(resumeJob ? {
                continuingJob: resumeJob.id,
                alreadyRenderedShots: carried.length,
                assembledFilmShots: carried.length + shotCount,
                note:
                  `Shots 1-${carried.length} are already rendered and cost nothing more; they go ` +
                  `into the final assembly. This estimate covers only the ${shotCount} new shots.`,
              } : {}),
            },
            estimate: {
              totalUsd: estimate,
              resolution: args.resolution,
              basis:
                `${shotCount} renders totalling ${totalSeconds}s at ` +
                `$${ratePerSecond(args.resolution).toFixed(2)}/s for ${args.resolution} = $${estimate.toFixed(2)}.`,
              isEstimate: true,
            },
            contract: { shots: outgoing },
            ...(resumeWarnings.length > 0 ? { warnings: resumeWarnings } : {}),
            ...costFields(sequencePaid),
            next: lintBlocked
              ? "The prompts fail the check. Show the sent prompts and the lint hits. Rewrite them " +
                "before confirm. Nothing was spent, and a retry is an edit of that prompt."
              : "Show the sent prompt, lint hits, pinned start frame, references, voice, duration, " +
                "resolution, and the quote. Call again with confirm: true only after they approve. " +
                "Do not set confirm without an explicit yes.",
            contractValidation: contractGate,
          }, null, 2),
        }],
      };
    }

    if (lintBlocked) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "refused",
            willRender: false,
            contract: { shots: outgoing },
            message:
              "The prompt fails the check. The next take is an edit of the prompt that was shown. " +
              "Nothing was spent.",
          }, null, 2),
        }],
      };
    }

    const sessionRefusal = await refuseIfSessionWillNotLast(totalSeconds * 1000);
    if (sessionRefusal) return withCost(sessionRefusal, sequencePaid);

    // Downloads and other fallible prep happen before the film is claimed, so a
    // bad audio URL cannot leave a claim that the heartbeat keeps fresh.
    const preparedAudio = {
      audioTrackFile: args.audioTrackUrl ? await resolveToLocalFile(args.audioTrackUrl) : undefined,
    };
    const audioTrackFile = preparedAudio.audioTrackFile;

    if (resumeJob) {
      const claim = await claimFilm(resumeJob.id);
      if (!claim.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: claim.message,
              detail: claim.message === ALREADY_RUNNING_HERE
                ? "This process already claimed this film. Wait for that render to finish, then check_sequence or list_films."
                : "Another process already claimed this film. Wait for it to finish, then check_sequence or list_films.",
              jobId: resumeJob.id,
            }, null, 2),
          }],
        };
      }
    }

    let handedToJob = false;
    try {
      if (resumeJob) await runResumeClaimProbe();

    const job: SequenceJob = {
      id: sequenceJobId(),
      startedAt: Date.now(),
      state: "running",
      owner: thisOwner(),
      // Total film length, not just this call's new shots.
      shotCount: carried.length + shotCount,
      completed: 0,
      estimateUsd: estimate,
      spentUsd: 0,
      shots: [],
      settings: {
        aspectRatio: args.aspectRatio,
        resolution: args.resolution,
        model: args.model,
        fadeDuration: args.fadeDuration,
        continuity: args.continuity,
        characters: args.characters,
        audioTrackFile,
        audioTrackVolume: args.audioTrackVolume,
        audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
        clipAudio: args.clipAudio,
        pin: args.pin,
        voiceId: args.voiceId,
        assemble: args.assemble,
      },
      ...(resumeJob ? {
        resumedFrom: { jobId: resumeJob.id, fromShot: carried.length },
        carriedOverUsd: Math.round(carried.reduce((sum, s) => sum + (s.costUsd ?? 0), 0) * 100) / 100,
        // A continued film keeps the original start anchor, so repairing shot 1
        // of the whole film still chains from where the film actually began.
        startFramePath: resumeJob.startFramePath,
        warnings: resumeJob.warnings ? [...resumeJob.warnings] : undefined,
        ...(resumeJob ? { spendLedger: carrySpend(resumeJob) } : {}),
        ledger: args.ledger
          ? {
              locations: args.ledger.locations ?? resumeJob.ledger?.locations ?? [],
              props: args.ledger.props ?? resumeJob.ledger?.props ?? [],
              wardrobeEvents: eventsWithShot(args.ledger.wardrobeEvents ?? resumeJob.ledger?.wardrobeEvents),
              propEvents: eventsWithShot(args.ledger.propEvents ?? resumeJob.ledger?.propEvents),
              shots: (args.ledger.shots ?? resumeJob.ledger?.shots) as ShotContinuity[] | undefined,
              shotSteps: args.ledger.shotSteps ?? resumeJob.ledger?.shotSteps,
              voiceId: args.voiceId ?? args.ledger.voiceId ?? resumeJob.ledger?.voiceId,
              promptStyle: args.promptStyle ?? args.ledger.promptStyle ?? resumeJob.ledger?.promptStyle,
              spokenLines: args.ledger.spokenLines ?? resumeJob.ledger?.spokenLines,
              humanVisionSignOff: args.ledger.humanVisionSignOff ?? resumeJob.ledger?.humanVisionSignOff,
              hasPortrait: args.ledger.hasPortrait ?? resumeJob.ledger?.hasPortrait,
              scaleMarks: args.ledger.scaleMarks ?? resumeJob.ledger?.scaleMarks,
              bodyClearance: args.ledger.bodyClearance ?? resumeJob.ledger?.bodyClearance,
              tier1: args.ledger.tier1 ?? resumeJob.ledger?.tier1,
            }
          : resumeJob.ledger,
      } : {
        startFramePath: resumeFramePath ?? args.firstFrameUrl,
        ...(args.ledger ? {
          ledger: {
            locations: args.ledger.locations ?? [],
            props: args.ledger.props ?? [],
            wardrobeEvents: eventsWithShot(args.ledger.wardrobeEvents),
            propEvents: eventsWithShot(args.ledger.propEvents),
            shots: args.ledger.shots as ShotContinuity[] | undefined,
            shotSteps: args.ledger.shotSteps,
            voiceId: args.voiceId ?? args.ledger.voiceId,
            promptStyle: args.promptStyle ?? args.ledger.promptStyle,
            spokenLines: args.ledger.spokenLines,
            humanVisionSignOff: args.ledger.humanVisionSignOff,
            hasPortrait: args.ledger.hasPortrait,
            scaleMarks: args.ledger.scaleMarks,
            bodyClearance: args.ledger.bodyClearance,
            tier1: args.ledger.tier1,
          },
        } : {}),
      }),
    };
    if (sequencePaid.budgetWarning) {
      job.warnings = [...(job.warnings ?? []), sequencePaid.budgetWarning];
    }
    if (sequenceBudget !== undefined) {
      job.spendLedger = {
        ...(job.spendLedger ?? { version: 1, spentUsd: recordedSpendUsd(job), pendingUsd: 0 }),
        thresholdUsd: sequenceBudget,
      };
    }
    await attachCharacterSnapshots(job, args.characters);
    sequenceJobs.set(job.id, job);
    void persistJob(job);

    // Deliberately not awaited: a multi-shot chain outlives the client's request
    // timeout, and awaiting it turns a finished film into a timeout error.
    const sourceId = resumeJob?.id;
    void runSequenceJob(job, {
      shots: args.shots,
      characters: args.characters,
      continuity: args.continuity,
      firstFrameUrl: args.firstFrameUrl,
      aspectRatio: args.aspectRatio,
      resolution: args.resolution,
      model: args.model,
      assemble: args.assemble,
      fadeDuration: args.fadeDuration,
      audioTrackFile,
      audioTrackVolume: args.audioTrackVolume,
      audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
      clipAudio: args.clipAudio,
      pin: args.pin,
      voiceId: args.voiceId ?? ledgerForGate?.voiceId,
      timeoutSecondsPerShot: args.timeoutSecondsPerShot,
      carriedShots: carried.length > 0 ? carried : undefined,
      resumeFramePath,
    }).finally(() => {
      if (sourceId) void releaseFilmClaim(sourceId);
    });
    handedToJob = true;

    // Give the first shot a short window so a single quick shot can come back
    // inline; anything longer is picked up by polling.
    const inlineDeadline = Date.now() + 25_000;
    while (Date.now() < inlineDeadline && job.state === "running" && job.shots.length === 0) {
      await sleep(500);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        action: job.state === "running" ? "started" : job.state,
        ...jobPayload(job),
        ...costFields(sequencePaid),
      }, null, 2) }],
    };
    } finally {
      if (resumeJob && !handedToJob) await releaseFilmClaim(resumeJob.id);
    }
  }
);

/**
 * Board a film: render the stills each shot is pinned to, before any video.
 *
 * Chosen over extending plan_storyboard with a `boardStills` flag for two
 * reasons. plan_storyboard is free and instant and several callers rely on that;
 * making it spend money when a flag is set turns one tool into two tools with
 * different failure modes, and a caller that forgets the flag gets a plan with
 * no frames while one that sets it by accident gets a bill. A separate tool also
 * gets its own confirm/estimate gate, which is the shape the rest of this server
 * already uses for spending (render_sequence, retry_shot). It reads a shot list
 * or a finished plan either way, so nothing is duplicated.
 *
 * The flow this enables: configure_film → board_film (pennies) → show the stills
 * → render_sequence with the returned shots (dollars).
 */
server.registerTool(
  "board_film",
  {
    description:
      "Board a film as stills before rendering it: generate one image per shot boundary, so " +
      "consecutive shots share a picture. render_sequence sends that closing frame only when pin " +
      "is \"both\"; the default pin is start, so the cut is not pixel-pinned unless you ask. " +
      "A portrait with no location photo is part of every frame's name, so changing it buys every " +
      "still again. A hero built from a portrait and a room is bought again with every confirmed " +
      "board, and a new hero buys every shot frame too. Two cents a still " +
      "against fourteen a second of video, so an eight-shot board costs about eighteen cents and " +
      "lets the user approve the look before the expensive half runs. Call without confirm for a " +
      "cost estimate; pass maxCostUsd to make it refuse rather than overspend. Frames already on " +
      "disk are reused free, so it is safe to re-run after a partial board. Returns `shots` ready " +
      "to paste into render_sequence with firstFrameUrl and lastFrameUrl already filled in. " +
      "Renders no video.",
    inputSchema: z.object({
      shots: z.array(z.object({
        prompt: z.string().optional().describe("What happens in the shot."),
        action: z.string().optional().describe(
          "Alias for prompt, so plan_storyboard output pastes in unchanged.",
        ),
        title: z.string().optional(),
        durationSeconds: z.number().min(1).max(15).default(8),
        locationId: z.string().optional(),
        continuityPrompt: z.string().optional(),
        wardrobeChanged: z.boolean().optional(),
        wardrobeEvents: z.array(WardrobeEventSchema).optional(),
        propEvents: z.array(PropEventSchema).optional(),
        middleKeyframe: z.boolean().optional().describe(
          "Plan an extra still at the midpoint of this shot, so the beat is not pinned only at its ends.",
        ),
      })).min(1).max(12).describe(
        "Shots in order. N shots produce N+1 stills, because the boundary between two shots is " +
        "one picture shared by both.",
      ),
      locations: z.array(LocationSchema).optional(),
      props: z.array(PropRecordSchema).optional(),
      wardrobeEvents: z.array(WardrobeEventSchema).optional(),
      propEvents: z.array(PropEventSchema).optional(),
      look: z.string().optional().describe(
        "Style and continuity wording folded into every still prompt: configure_film's " +
        "continuityBlock, or the style line from the confirmed config. Without it the stills " +
        "are boarded in whatever look each prompt implies.",
      ),
      cast: z.string().optional().describe(
        "Who is in the film, in plain words, repeated verbatim into every still prompt. This is " +
        "the only thing that reliably holds a face across a board: a measured three-shot board " +
        "chained each still from the previous one and still drifted from a bare-headed man to a " +
        "flat cap to a top hat, because the stills endpoint treats a reference image as a loose " +
        "hint. Write it as a physical description, not a name: 'one man, grey beard, dark flat " +
        "cap, black double-breasted coat, brass-tipped pole'. Derive it from configure_film's " +
        "characters.",
      ),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      characters: z.array(z.string()).optional().describe(
        "Character names from create_character. Their portraits go on every still, so the face is " +
        "settled before the first video render.",
      ),
      referenceImageUrls: z.array(z.string()).optional().describe(
        "Extra reference stills for the board: https URLs, data URIs, or local paths.",
      ),
      baseImageUrl: z.string().optional().describe(
        "A location photo every frame is EDITED from, rather than a hint for a fresh picture. " +
        "This is the one that holds a room and a skyline across a board: on the plain stills " +
        "route a reference is a loose hint the prompt can overrule, so the city gets redrawn in " +
        "every frame. Defaults to the first photo of the first character whose role is Location, " +
        "so a stored office needs nothing passed here.",
      ),
      maxCostUsd: z.number().min(0).optional().describe(
        "Hard ceiling for the board. If the estimate is over it, nothing renders and the tool " +
        "reports the figure. Still costs are small, so this is mostly a guard against a big board.",
      ),
      confirm: z.boolean().default(false).describe(
        "Must be true to render stills. Call once without it to get the estimate, show it to the " +
        "user, and call again with true only after they approve. confirm does not override a " +
        "failed wardrobe check.",
      ),
      overrideValidation: z.boolean().default(false).describe(
        "Board even when wardrobe is unchecked or the shot contracts fail. The default is to refuse. " +
        "confirm alone does not unblock a refusal.",
      ),
      jobId: z.string().optional().describe(
        "Film whose cumulative spend this board counts toward.",
      ),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    const { urls, missing } = mergeCharacterReferences(args.characters, args.referenceImageUrls);
    // Default the base to a Location character unless the caller named one.
    const baseImageUrl = args.baseImageUrl ?? findLocationBase(args.characters);

    const shotLocations = args.shots.map((shot) => shot.locationId);
    const fromShotsWardrobe = args.shots.flatMap((shot, index) =>
      stampShotNumbers(shot.wardrobeEvents, index + 1),
    );
    const fromShotsProps = args.shots.flatMap((shot, index) =>
      stampShotNumbers(shot.propEvents, index + 1),
    );
    const wardrobeEvents = [
      ...(args.wardrobeEvents ?? []),
      ...fromShotsWardrobe,
    ].filter((event): event is WardrobeEvent => typeof event.shot === "number");
    const propEvents = [
      ...(args.propEvents ?? []),
      ...fromShotsProps,
    ].filter((event): event is PropEvent => typeof event.shot === "number");
    const { snapshots } = buildContinuityLedger({
      characterNames: args.characters ?? [],
      shotCount: args.shots.length,
      shotLocations,
      locations: args.locations,
      props: args.props,
      wardrobeEvents,
      propEvents,
    });
    const boardedShots = args.shots.map((shot, index) => {
      const snapshot = snapshots[index];
      const extra = shot.continuityPrompt ?? snapshot?.prompt ?? "";
      return {
        ...shot,
        continuityPrompt: extra || undefined,
        wardrobeChanged:
          Boolean(shot.wardrobeChanged) ||
          wardrobeEvents.some((event) => event.shot === index + 1),
      };
    });

    const rawRefs = urls.filter((url) => url !== baseImageUrl);
    const referenceImageUrls = rawRefs.length > 0 ? rawRefs : undefined;
    const hasPortrait = Boolean(referenceImageUrls && referenceImageUrls.length > 0);
    const contractValidation = runPreVideoGate({
      overrideValidation: args.overrideValidation,
      plan: {
        characters: (args.characters ?? [])
          .map((name) => lookupCharacter(name))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .map((entry) => characterFromRecord(entry)),
        locations: args.locations,
        props: args.props,
        wardrobeEvents,
        propEvents,
        shotLocations,
        shotCount: args.shots.length,
        hasReferencePicture: Boolean(baseImageUrl) || hasPortrait,
        hasPortrait,
        shotPrompts: boardedShots
          .map((shot, index) => ({ shot: index + 1, prompt: shot.prompt ?? shot.action ?? "" }))
          .filter((entry) => entry.prompt.trim().length > 0),
      },
    });
    const framePreview = planBoardFrames({
      shots: boardedShots,
      aspectRatio: args.aspectRatio,
      look: args.look,
      cast: args.cast,
      baseImageUrl,
      referenceImageUrls,
    });
    if (framePreview.some((frame) => frame.wardrobeUnchecked)) {
      contractValidation.violations.push({
        code: "wardrobe-unchecked",
        shot: framePreview.find((frame) => frame.wardrobeUnchecked)?.shot ?? 1,
        message:
          "This board names a cast and has neither a portrait nor a base picture, so wardrobe is unchecked.",
      });
      if (args.overrideValidation) {
        contractValidation.ok = false;
        contractValidation.blocked = false;
        contractValidation.status = "override";
        contractValidation.tier0 = "fail";
        contractValidation.message =
          "Wardrobe is unchecked; overrideValidation is set, so boarding may proceed.";
      } else {
        contractValidation.ok = false;
        contractValidation.blocked = true;
        contractValidation.status = "fail";
        contractValidation.tier0 = "fail";
        contractValidation.message =
          "board_film refused to start because this board names a cast and has neither a portrait " +
          "nor a location picture, so wardrobe is unchecked. Pass overrideValidation: true to board " +
          "anyway. confirm alone does not unblock it.";
      }
    }
    if (contractValidation.message) {
      contractValidation.message = messageForBoard(contractValidation.message);
    }
    const decision = decideSpend(args.confirm, contractValidation);
    if (decision === "refused") {
      const preview = await boardFilm(
        {
          shots: boardedShots,
          aspectRatio: args.aspectRatio,
          look: args.look,
          scene: locationScene(args.characters),
          cast: args.cast,
          maxCostUsd: args.maxCostUsd,
          confirm: false,
          blocked: true,
        },
        {
          outputDir: OUTPUT_DIR,
          referenceImageUrls,
          baseImageUrl,
          generateStill: async (job, opts) => generateGrokStill(job, opts),
        },
      );
      return refusal({
        action: "refused",
        willSpend: false,
        estimate: preview.estimate,
        next: preview.next,
        contractValidation,
        message: contractValidation.message ?? messageForBoard(undefined),
      });
    }
    if (args.jobId) await refreshJobsFromDisk();
    const boardJob = args.jobId ? sequenceJobs.get(args.jobId) : undefined;
    const sentRefs = decision === "spend"
      ? await withPersonCutouts(args.characters, rawRefs)
      : rawRefs;
    const boardDeps = {
      outputDir: OUTPUT_DIR,
      referenceImageUrls: sentRefs.length > 0 ? sentRefs : undefined,
      baseImageUrl,
      generateStill: async (job: Parameters<typeof generateGrokStill>[0], opts: Parameters<typeof generateGrokStill>[1]) => generateGrokStill(job, opts),
    };
    const boardFingerprint = quoteFingerprint({
      kind: "board",
      prompts: boardedShots.map((shot) => shot.prompt ?? shot.action ?? ""),
      look: args.look ?? "",
      cast: args.cast ?? "",
      middles: boardedShots.map((shot) => Boolean(shot.middleKeyframe)),
      aspectRatio: args.aspectRatio,
    });
    const priced = await boardFilm(
      {
        shots: boardedShots,
        aspectRatio: args.aspectRatio,
        look: args.look,
        scene: locationScene(args.characters),
        cast: args.cast,
        maxCostUsd: args.maxCostUsd,
        confirm: false,
      },
      boardDeps,
    );
    const boardPaid = await quoteGate(
      { ...args, budgetUsd: args.budgetUsd ?? boardJob?.spendLedger?.thresholdUsd },
      "board",
      priced.estimate.estimatedUsd,
      boardFingerprint,
      boardJob,
    );
    const boardCostRefusal = costRefusal(boardPaid);
    if (boardCostRefusal) return boardCostRefusal;
    if (decision === "spend") {
      const sessionRefusal = await refuseIfSessionWillNotLast(60_000);
      if (sessionRefusal) return withCost(sessionRefusal, boardPaid);
    }
    const board = decision === "spend"
      ? await boardFilm(
        {
          shots: boardedShots,
          aspectRatio: args.aspectRatio,
          look: args.look,
          scene: locationScene(args.characters),
          cast: args.cast,
          maxCostUsd: args.maxCostUsd,
          confirm: true,
        },
        boardDeps,
      )
      : priced;
    let boardSpend: NoteOutcome | undefined;
    if (boardJob && args.jobId && (board.estimate.spentUsd ?? 0) > 0) {
      boardSpend = await recordFilmCost(args.jobId, "board", board.estimate.spentUsd, undefined);
    }

    const boardFrames = Array.isArray(board.frames) ? board.frames : [];
    const payload = {
      ...board,
      contract: {
        frames: boardFrames.map((frame) => ({
          index: frame.index,
          sentPrompt: frame.prompt,
          lintHits: lintSentPrompt(frame.prompt),
          pinnedStart: frame.path ?? null,
        })),
        note:
          "A still prompt names the room, because the still has to generate it. A video prompt with a pinned start frame does not restate the room. Closing frames are not sent unless pin is both.",
      },
      contractValidation,
      continuity: {
        locations: args.locations ?? [],
        props: args.props ?? [],
        wardrobeEvents,
        propEvents,
        shots: snapshots,
      },
      ...(snapshots.some((snapshot) => snapshot.warnings.length > 0)
        ? { continuityWarnings: snapshots.flatMap((snapshot) => snapshot.warnings) }
        : {}),
      ...(missing.length > 0 ? { unknownCharacters: missing } : {}),
      ...(board.action === "boarded" || board.action === "partial"
        ? { renderShots: toRenderShots(board) }
        : {}),
      ...costFields(boardPaid),
      ...deferredField(boardSpend, "spendNote"),
    };

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

/**
 * Re-render one shot of a finished film and splice it back in.
 *
 * Without this, a film is all-or-nothing: one bad shot and the choice is ship it
 * or pay for the whole chain again. Everything before the bad shot is carried
 * over untouched, everything after it is reused, and only the one shot is
 * rendered. The film is then re-assembled from all of it, with the same
 * resolution, join style and audio bed as the original.
 *
 * It is deliberately honest about what it does not do: the shots after the
 * repaired one were chained from the ORIGINAL shot's last frame, so their first
 * frames no longer match the new shot's last frame. The seam after the repair is
 * therefore a genuine cut rather than a chained join. The tool says so in
 * `warnings` instead of implying the film is as continuous as before.
 */
server.registerTool(
  "retry_shot",
  {
    description:
      "Re-render a single shot of a finished render_sequence film and splice it back in, keeping " +
      "every other shot exactly as it was. Only the one shot costs money. Use it when a shot came " +
      "back wrong: wrong action, a face drifted, an unwanted object appeared. Call without confirm " +
      "for the price of that one render, then again with confirm: true after the user approves. " +
      "Read the warnings: the shot is re-chained from the previous shot's frame, but the shots " +
      "after it were built from the old frame, so that next join becomes a cut.",
    inputSchema: z.object({
      jobId: z.string().describe("The finished job whose shot needs replacing."),
      shotIndex: z.number().int().min(1).describe("1-based shot number, as reported in the job."),
      prompt: z.string().optional().describe(
        "New prompt for the shot. Omit to re-render the same prompt, which is right for a bad " +
        "roll; give a new one when the prompt itself was wrong.",
      ),
      durationSeconds: z.number().min(1).max(15).optional(),
      confirm: z.boolean().default(false),
      overrideValidation: z.boolean().default(false),
      timeoutSecondsPerShot: z.number().min(10).max(600).default(240),
      ...costApprovalFields,
    }),
  },
  async (args, extra) => {
    const cancelled = cancelledBeforeSpend(extra);
    if (cancelled) return cancelled;
    await refreshJobsFromDisk();
    const original = sequenceJobs.get(args.jobId);
    if (!original) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Unknown jobId",
            detail:
              "No film has that id. Call list_films to see every film on disk with its job id.",
            known: Array.from(sequenceJobs.keys()).slice(-5),
          }, null, 2),
        }],
      };
    }
    if (otherProcessHolds(original.owner) || otherProcessHolds(original.claim)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: ALREADY_RUNNING,
            detail: "Another process already claimed this film. Wait for it to finish, then check_sequence or list_films.",
            jobId: original.id,
          }, null, 2),
        }],
      };
    }
    if (original.state === "running") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "That film is still rendering",
            detail: "Wait for check_sequence to report done before repairing a shot.",
            jobId: original.id,
          }, null, 2),
        }],
      };
    }

    const index = args.shotIndex;
    const target = original.shots.find((shot) => shot.index === index);
    if (!target) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No shot ${index} in that film`,
            shots: original.shots.map((shot) => ({ index: shot.index, title: shot.title })),
          }, null, 2),
        }],
      };
    }
    if (!target.prompt) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "That shot has no recorded prompt to re-render",
            detail:
              "It was rendered before this version, or it was carried in from another film. " +
              "Pass `prompt` explicitly.",
            shotIndex: index,
          }, null, 2),
        }],
      };
    }

    const duration = args.durationSeconds ?? target.durationSeconds ?? 8;
    const prompt = args.prompt ?? target.prompt;
    const retryResolution = original.settings?.resolution ?? "720p";
    const retryRate = ratePerSecond(retryResolution);
    const estimateUsd = Math.round(duration * retryRate * 100) / 100;
    const retryFingerprint = quoteFingerprint({
      kind: "retry",
      jobId: original.id,
      shotIndex: index,
      durationSeconds: duration,
      resolution: retryResolution,
      prompt,
    });
    const retryBudget = args.budgetUsd ?? original.spendLedger?.thresholdUsd;
    const retryPaid = await quoteGate(
      { ...args, budgetUsd: retryBudget },
      "retry",
      estimateUsd,
      retryFingerprint,
      original,
    );
    const retryCostRefusal = costRefusal(retryPaid);
    if (retryCostRefusal) return retryCostRefusal;
    const retrySent = sentShotPrompt(original.settings?.continuity, { prompt: prompt ?? "" });
    const retryHits = lintSentPrompt(retrySent);
    const retryContract = {
      sentPrompt: retrySent,
      lintHits: retryHits,
      resolution: retryResolution,
      durationSeconds: duration,
      pin: original.settings?.pin ?? "start",
      startFrame: original.startFramePath ?? null,
      voiceId: original.settings?.voiceId ?? null,
      quote: {
        totalUsd: estimateUsd,
        ratePerSecond: retryRate,
        basis: `1 render of ${duration}s at $${retryRate.toFixed(2)}/s for ${retryResolution} = $${estimateUsd.toFixed(2)}.`,
      },
    };

    const before = original.shots.filter((shot) => shot.index < index);
    const after = original.shots.filter((shot) => shot.index > index);

    if (!args.confirm) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "estimate-only",
            willRender: false,
            plan: {
              repairing: original.id,
              shotIndex: index,
              shotTitle: target.title,
              durationSeconds: duration,
              prompt,
              reusedShots: before.length + after.length,
              reRenderedShots: 1,
              reassemblesFilm: original.settings?.assemble ?? true,
              note:
                `Shot ${index} is re-rendered; the other ${before.length + after.length} are reused ` +
                `at no cost. The film is re-assembled with the original resolution, joins and audio.`,
            },
            estimate: {
              totalUsd: estimateUsd,
              resolution: retryResolution,
              basis: retryContract.quote.basis,
              isEstimate: true,
            },
            contract: retryContract,
            ...costFields(retryPaid),
            caveat:
              after.length === 0
                ? "This is the last shot, so nothing downstream depends on it."
                : after.length === 1
                  ? `Shot ${index + 1} was chained from the ORIGINAL shot ${index}'s last frame. It is kept ` +
                    "as-is, so the join after the repair will be a cut rather than a chained continuation. " +
                    "If that seam matters, repair that shot too."
                  : `Shots ${index + 1} to ${original.shots.length} were chained from the ORIGINAL shot ${index}'s ` +
                    "last frame. They are kept as-is, so the join after the repair will be a cut rather than a " +
                    "chained continuation. If that seam matters, repair those shots too.",
            next: retryHits.length
              ? "The prompt fails the check. Show the failures and the prompt that would be sent. Edit it. Nothing was spent."
              : "Show the sent prompt, the lint hits, the price, and the caveat. Call again with confirm: true only after they approve. Do not spend the retry automatically.",
          }, null, 2),
        }],
      };
    }

    if (retryHits.length > 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "refused",
            willRender: false,
            contract: retryContract,
            message: "The prompt fails the check. The next take is an edit of that prompt. Nothing was spent.",
          }, null, 2),
        }],
      };
    }

    const repairGate = gateRenderSequence({
      plan: original.ledger
        ? continuityPlanFromRenderArgs({
            shots: original.shots.map((shot) => ({ prompt: shot.prompt })),
            characters: original.settings?.characters,
            ledger: original.ledger,
          })
        : undefined,
      overrideValidation: args.overrideValidation,
    });
    if (decideSpend(true, repairGate) !== "spend") {
      return refusal({
        action: "refused",
        willRender: false,
        contractValidation: repairGate,
        message: repairGate.message ?? RENDER_UNCHECKED,
      });
    }
    const repairSession = await refuseIfSessionWillNotLast(duration * 1000);
    if (repairSession) return withCost(repairSession, retryPaid);

    const claim = await claimFilm(original.id);
    if (!claim.ok) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: claim.message,
            detail: claim.message === ALREADY_RUNNING_HERE
              ? "This process already claimed this film. Wait for that render to finish, then check_sequence or list_films."
              : "Another process already claimed this film. Wait for it to finish, then check_sequence or list_films.",
            jobId: original.id,
          }, null, 2),
        }],
      };
    }

    let handedToJob = false;
    try {
    const settings = original.settings;
    const job: SequenceJob = {
      id: sequenceJobId(),
      startedAt: Date.now(),
      state: "running",
      owner: thisOwner(),
      shotCount: original.shots.length,
      completed: before.length,
      estimateUsd,
      spentUsd: 0,
      shots: [],
      settings,
      startFramePath: original.startFramePath,
      warnings: [...(original.warnings ?? []), ...(retryPaid.budgetWarning ? [retryPaid.budgetWarning] : [])],
      ...(carrySpend(original) ? { spendLedger: carrySpend(original) } : {}),
      repairedFrom: { jobId: original.id, shotIndex: index, originalCostUsd: target.costUsd },
      ledger: original.ledger,
      // Every reused shot was paid for by the original film. Count it, so the
      // reported film total is the film's real cost rather than this call's.
      carriedOverUsd: Math.round(
        [...before, ...after].reduce((sum, shot) => sum + (shot.costUsd ?? 0), 0) * 100,
      ) / 100,
    };

    if (after.length > 0) {
      const later = after.length === 1
        ? `shot ${index + 1} still begins`
        : `shots ${index + 1}-${original.shots.length} still begin`;
      job.warnings!.push(
        `Shot ${index} was re-rendered, but ${later} from the original shot ${index}'s last frame, so the ` +
        `join after shot ${index} is a cut, not a chained continuation.`,
      );
    }

    if (retryBudget !== undefined) {
      job.spendLedger = {
        ...(job.spendLedger ?? { version: 1, spentUsd: recordedSpendUsd(original), pendingUsd: 0 }),
        thresholdUsd: retryBudget,
      };
    }
    await attachCharacterSnapshots(job, settings?.characters);
    sequenceJobs.set(job.id, job);
    void persistJob(job);

    void withoutHttpRenderMemo(() => runSequenceJob(job, {
      shots: [{ prompt, durationSeconds: duration, title: target.title }],
      characters: settings?.characters,
      continuity: settings?.continuity,
      firstFrameUrl: original.startFramePath,
      aspectRatio: settings?.aspectRatio ?? "16:9",
      resolution: settings?.resolution ?? "720p",
      model: settings?.model ?? "grok-imagine-video-1.5",
      assemble: settings?.assemble ?? true,
      fadeDuration: settings?.fadeDuration ?? 0,
      audioTrackFile: settings?.audioTrackFile,
      audioTrackVolume: settings?.audioTrackVolume,
      audioTrackFadeOutSeconds: settings?.audioTrackFadeOutSeconds,
      timeoutSecondsPerShot: args.timeoutSecondsPerShot,
      carriedShots: before.length > 0 ? before : undefined,
      trailingShots: after.length > 0 ? after : undefined,
      // Chain the replacement from the shot that precedes it, exactly as the
      // original film did, so the repaired shot fits the same join.
      resumeFramePath: before.at(-1)?.framePath ?? original.startFramePath,
    }).finally(() => {
      void releaseFilmClaim(original.id);
    }));
    handedToJob = true;

    const inlineDeadline = Date.now() + 25_000;
    while (Date.now() < inlineDeadline && job.state === "running" && job.shots.length === before.length) {
      await sleep(500);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        action: job.state === "running" ? "started" : job.state,
        ...jobPayload(job),
        ...costFields(retryPaid),
      }, null, 2) }],
    };
    } finally {
      if (!handedToJob) await releaseFilmClaim(original.id);
    }
  }
);

/**
 * List the films this user has made, newest first.
 *
 * Read-only and free. The point is that a film is no longer trapped in the
 * session that rendered it: come back a week later and the job id, the shot
 * count, the cost and the file are all still there to continue or repair.
 */
server.registerTool(
  "list_films",
  {
    description:
      "List films rendered with this plugin, newest first: job id, state, shot count, duration, " +
      "cost and file path. Read-only and free. Use it to find a film to continue with " +
      "resumeFromJobId or to repair with retry_shot, including one made in an earlier session.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      includeUnfinished: z.boolean().default(false).describe(
        "Also list films that stopped or failed, which still hold every shot they paid for.",
      ),
    }),
  },
  async (args) => {
    await refreshJobsFromDisk();
    const all = Array.from(sequenceJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
    const shown = await Promise.all(all
      .filter((job) => args.includeUnfinished || job.state === "completed")
      .slice(0, args.limit)
      .map(async (job) => {
        const queued = await readQueuedFilmSpend(job.id, job.spendLedger?.appliedNoteIds);
        return {
        jobId: job.id,
        state: job.state,
        startedAt: new Date(job.startedAt).toISOString(),
        shots: job.shots.length,
        durationSeconds: job.filmDurationSeconds,
        spentUsd: Math.round(job.spentUsd * 100) / 100,
        ...(queued.pendingSpendUsd > 0 ? { pendingSpendUsd: queued.pendingSpendUsd } : {}),
        ...(queued.pendingThresholdUsd !== undefined ? { pendingThresholdUsd: queued.pendingThresholdUsd } : {}),
        filmPath: job.filmPath,
        firstShot: job.shots[0]?.title,
        repaired: job.repairedFrom ? `replaced shot ${job.repairedFrom.shotIndex} of ${job.repairedFrom.jobId}` : undefined,
        error: job.error,
        };
      }));

    return structuredText({
      count: shown.length,
      films: shown,
      storage: JOBS_DIR,
      next: shown.length === 0
        ? "No films yet. Configure one with configure_film, then render_sequence."
        : "Pass a jobId to render_sequence as resumeFromJobId to extend that film, or to " +
          "retry_shot to replace one of its shots.",
    });
  }
);

/**
 * Poll a render_sequence job.
 *
 * Separate tool rather than a second mode on render_sequence, so polling can
 * never be mistaken for a new render and never spends anything.
 */
server.registerTool(
  "check_sequence",
  {
    description:
      "Check progress on a render_sequence job. Read-only and free: it renders nothing and spends " +
      "nothing. Returns progress while running, and the film path plus actual cost when finished.",
    inputSchema: z.object({
      jobId: z.string().describe("The jobId render_sequence returned."),
    }),
  },
  async (args) => {
    await refreshJobsFromDisk();
    const job = sequenceJobs.get(args.jobId);
    if (!job) {
      return structuredText({
        error: "Unknown jobId",
        detail: "No film has that id. Call list_films to see every film on disk with its job id.",
        known: Array.from(sequenceJobs.keys()).slice(-5),
      });
    }
    const queued = await readQueuedFilmSpend(job.id, job.spendLedger?.appliedNoteIds);
    return structuredText({ ...jobPayload(job), ...queuedFields(queued) });
  }
);

const reviewShotSchema = z.object({
  index: z.number().int().min(1),
  worn: z.array(z.string()).optional(),
  props: z.array(z.object({
    id: z.string(),
    locationId: z.string(),
    placement: z.string(),
    holder: z.string().optional(),
  })).optional(),
  lastFramePath: z.string().optional(),
  firstFramePath: z.string().optional(),
  referencePath: z.string().optional(),
  durationSeconds: z.number().optional(),
  pin: z.enum(["start", "both"]).optional(),
  boardStillPaths: z.array(z.string()).optional(),
  extendedFrom: z.string().optional(),
});

function filesIdentical(left: string, right: string): boolean {
  try {
    const a = createHash("sha256").update(readFileSync(left)).digest("hex");
    const b = createHash("sha256").update(readFileSync(right)).digest("hex");
    return a === b;
  } catch {
    return false;
  }
}

async function reviewShotsFromJob(
  job: SequenceJob,
  reviewFrameDir?: string,
): Promise<{ shots: ReviewShot[]; sources: Map<string, string> }> {
  const shots: ReviewShot[] = [];
  const sources = new Map<string, string>();
  for (let index = 0; index < job.shots.length; index += 1) {
    const shot = job.shots[index];
    const ledger = job.ledger?.shots?.find((entry) => entry.shot === shot.index);
    const worn = ledger?.checklists.flatMap((list) => list.worn.map((layer) => layer.id));
    let opening = shot.openingFramePath;
    if (!opening && shot.localPath && existsSync(shot.localPath) && reviewFrameDir) {
      const extracted = await extractFirstFrame(shot.localPath, reviewFrameDir);
      if (extracted) {
        opening = extracted;
        sources.set(extracted, shot.localPath);
      }
    }
    shots.push({
      index: shot.index,
      ...(ledger ? { worn: worn ?? [] } : {}),
      ...(ledger
        ? {
          props: ledger.propsInView.map((prop) => ({
            id: prop.id,
            locationId: prop.locationId,
            placement: prop.placement,
            ...(prop.holder ? { holder: prop.holder } : {}),
          })),
        }
        : {}),
      lastFramePath: shot.framePath,
      firstFramePath: opening,
      durationSeconds: shot.durationSeconds,
      pin: shot.pinUsed ?? job.settings?.pin,
      ...(shot.lastFramePath ? { boardStillPaths: [shot.lastFramePath] } : {}),
    });
  }
  return { shots, sources };
}

function detachReviewFrames(
  review: ContinuityReview,
  tempDir: string | undefined,
  sources: Map<string, string>,
): ContinuityReview {
  if (!tempDir) return review;
  const prefix = tempDir.endsWith("/") ? tempDir : `${tempDir}/`;
  return {
    ...review,
    findings: review.findings.map((finding) => {
      if (!finding.evidence) return finding;
      const touched = finding.evidence.artifactPaths.some((file) => file === tempDir || file.startsWith(prefix));
      if (!touched) return finding;
      return {
        ...finding,
        evidence: {
          ...finding.evidence,
          artifactPaths: finding.evidence.artifactPaths.map((file) => (
            file === tempDir || file.startsWith(prefix) ? (sources.get(file) ?? file) : file
          )),
          ephemeral: true,
        },
      };
    }),
  };
}

server.registerTool(
  "review_continuity",
  {
    description:
      "Review what crosses each cut in a film: wardrobe, props, pose at the seam, lighting, and " +
      "identity. Each finding is measured, visually flagged, or unverified, and each one carries " +
      "evidence or an abstention. Free. It does not render, delete, reorder, or spend, and it " +
      "does not call a vision API. Style and story notes are ignored.",
    inputSchema: z.object({
      jobId: z.string().optional().describe("Persist the review on this film. A running render is not stopped."),
      shots: z.array(reviewShotSchema).optional(),
      measurements: z.array(z.object({
        afterShot: z.number().int().min(1),
        agreement: z.number().optional(),
        method: z.string().optional(),
        meanLumaDelta: z.number().optional(),
        identityAgreement: z.number().optional(),
      })).optional(),
      styleNotes: z.array(z.string()).optional().describe("Ignored. Not a boundary finding."),
      narrativeSuggestions: z.array(z.string()).optional().describe("Ignored. Not a boundary finding."),
      resolution: z.enum(["480p", "720p", "1080p"]).optional(),
    }),
  },
  async (args) => {
    const callerSupplied = Boolean(args.shots);
    let shots = args.shots as ReviewShot[] | undefined;
    let ledgerArtifact = callerSupplied ? "caller-supplied" : "ledger";
    let plannedShots: number[] = [];
    if (args.jobId) await refreshJobsFromDisk();
    const job = args.jobId ? sequenceJobs.get(args.jobId) : undefined;
    if (args.jobId && !job) {
      return refusal({ error: "Unknown jobId", executed: false, willRender: false, willSpend: false });
    }
    const reviewFrameDir = !shots && job
      ? await mkdtemp(join(JOBS_DIR, `.review-frames-${process.pid}-${hostKey()}-`))
      : undefined;
    const frameSources = new Map<string, string>();
    try {
    if (!shots && job) {
      const loaded = await reviewShotsFromJob(job, reviewFrameDir);
      shots = loaded.shots;
      for (const [frame, source] of loaded.sources) frameSources.set(frame, source);
      ledgerArtifact = `job:${job.id}#ledger`;
      plannedShots = [
        ...(job.ledger?.wardrobeEvents ?? []).map((event) => event.shot),
        ...(job.ledger?.propEvents ?? []).map((event) => event.shot),
      ];
    }
    if (!shots || shots.length === 0) {
      return refusal({
        error: "No shots to review",
        executed: false,
        willRender: false,
        willSpend: false,
      });
    }
    const review = reviewContinuity({
      shots,
      measurements: (args.measurements ?? []).map((measurement) => ({ ...measurement, source: "caller" as const })),
      fileExists: (file) => existsSync(file),
      filesIdentical,
      ledgerArtifact,
      plannedShots,
      styleNotes: args.styleNotes,
      narrativeSuggestions: args.narrativeSuggestions,
      resolution: args.resolution,
    });
    const published = detachReviewFrames(review, reviewFrameDir, frameSources);
    let persisted = false;
    let persistError: string | undefined;
    if (args.jobId && !callerSupplied) {
      const saved = await saveJobAnnotation(args.jobId, (current) => {
        current.continuityReview = published;
      });
      persisted = saved.ok;
      if (!saved.ok) persistError = saved.message;
    }
    return refusal({
      ...published,
      persisted,
      source: callerSupplied ? "caller-supplied" : "job",
      reproducible: !callerSupplied,
      ...(persistError ? { persistError } : {}),
    });
    } finally {
      if (reviewFrameDir) await rm(reviewFrameDir, { recursive: true, force: true });
    }
  },
);

server.registerTool(
  "propose_repair",
  {
    description:
      "Propose least-cost repairs for one bad shot from the frames that were actually used. " +
      "Free and advisory: it does not approve and it does not render. When a job id is given, " +
      "retry-alone includes the costQuote retry_shot accepts. The other options are advice only.",
    inputSchema: z.object({
      jobId: z.string().optional(),
      badShot: z.number().int().min(1),
      resolution: z.enum(["480p", "720p", "1080p"]).optional().describe(
        "Quote the options at this resolution. Omitted means 720p, the same default as a render.",
      ),
      shots: z.array(z.object({
        index: z.number().int().min(1),
        durationSeconds: z.number().min(1).max(15),
        pin: z.enum(["start", "both"]).optional(),
        framePath: z.string().optional(),
        firstFramePath: z.string().optional(),
        lastFramePath: z.string().optional(),
        boardStillPaths: z.array(z.string()).optional(),
        extendedFrom: z.string().optional(),
      })).optional(),
      strategyId: z.enum(["retry-alone", "retry-dependents", "reboard-boundary", "accept-note"]).optional(),
      budgetUsd: z.number().min(0).optional().describe(
        "Film budget recorded with the proposal. Crossing it warns. It does not render.",
      ),
      confirm: z.boolean().default(false).describe(
        "Ignored. This tool never approves and never renders.",
      ),
      approvedUsd: z.number().optional(),
      approvedKind: z.enum(["board", "video", "still", "extend", "retry"]).optional(),
      approvedFingerprint: z.string().optional(),
      overrideValidation: z.boolean().default(false),
    }),
  },
  async (args) => {
    let source: DependencyShot[] | undefined = args.shots?.map((shot) => ({
      index: shot.index,
      durationSeconds: shot.durationSeconds,
      pin: shot.pin ?? "start",
      framePath: shot.framePath,
      firstFramePath: shot.firstFramePath,
      lastFramePath: shot.lastFramePath,
      boardStillPaths: shot.boardStillPaths,
      extendedFrom: shot.extendedFrom,
    }));
    let resolution = args.resolution ?? "720p";
    if (!source && args.jobId) {
      await refreshJobsFromDisk();
      const job = sequenceJobs.get(args.jobId);
      if (!job) {
        return refusal({ error: "Unknown jobId", executed: false, willRender: false, willSpend: false });
      }
      const pin = job.settings?.pin ?? "start";
      source = job.shots.map((shot) => ({
        index: shot.index,
        durationSeconds: shot.durationSeconds ?? 8,
        pin: shot.pinUsed ?? pin,
        framePath: shot.framePath,
        firstFramePath: shot.openingFramePath,
        lastFramePath: shot.lastFramePath,
        boardStillPaths: shot.lastFramePath ? [shot.lastFramePath] : undefined,
        framesRecorded: Boolean(shot.openingFramePath),
      }));
      const fromJob = job.settings?.resolution;
      if (!args.resolution && (fromJob === "480p" || fromJob === "720p" || fromJob === "1080p")) {
        resolution = fromJob;
      }
    }
    if (!source || source.length === 0) {
      return refusal({ error: "No shots", executed: false, willRender: false, willSpend: false });
    }
    const graph = buildDependencyGraph(source);
    const proposal = proposeRepair({ graph, badShot: args.badShot, resolution });
    const repairJob = args.jobId ? sequenceJobs.get(args.jobId) : undefined;
    const badRecord = source.find((shot) => shot.index === args.badShot);
    const options = proposal.options.map((option) => {
      if (option.id !== "retry-alone" || !args.jobId) {
        return { ...option, advisory: true as const };
      }
      const fingerprint = quoteFingerprint({
        kind: "retry",
        jobId: args.jobId,
        shotIndex: args.badShot,
        durationSeconds: badRecord?.durationSeconds ?? 0,
        resolution,
        prompt: repairJob?.shots.find((shot) => shot.index === args.badShot)?.prompt ?? "",
      });
      return {
        ...option,
        costQuote: {
          version: 1 as const,
          kind: "retry" as const,
          usd: option.costUsd,
          fingerprint,
        },
      };
    });
    let persisted = false;
    let persistError: string | undefined;
    if (args.jobId) {
      const saved = await saveJobAnnotation(args.jobId, (job) => {
        job.dependencies = graph;
        job.repairProposal = proposal;
        if (args.budgetUsd !== undefined) {
          const spent = recordedSpendUsd(job);
          job.spendLedger = {
            ...(job.spendLedger ?? { version: 1, spentUsd: spent, pendingUsd: 0 }),
            thresholdUsd: args.budgetUsd,
            spentUsd: job.spendLedger?.entries?.length ? job.spendLedger.spentUsd : spent,
          };
        }
      });
      persisted = saved.ok;
      if (!saved.ok) persistError = saved.message;
    }
    return refusal({
      ...proposal,
      options,
      advisory: true,
      persisted,
      ...(persistError ? { persistError } : {}),
    });
  },
);

let beforeAdvisory: (() => Promise<void>) | undefined;
let beforeAdvisoryFrames: (() => Promise<void>) | undefined;

/** Test seam. A probe can pause a free tool before it reads or writes. */
export function setBeforeAdvisoryProbe(next: (() => Promise<void>) | undefined): void {
  beforeAdvisory = next;
}

/** Test seam. A probe can pause after a review-frame directory is created and before it is removed. */
export function setBeforeAdvisoryFramesProbe(next: (() => Promise<void>) | undefined): void {
  beforeAdvisoryFrames = next;
}

async function attachCharacterSnapshots(job: SequenceJob, names: string[] | undefined): Promise<void> {
  if (!names || names.length === 0) return;
  const snapshots: NonNullable<SequenceJob["characterSnapshots"]> = [];
  for (const name of names) {
    try {
      const snap = await snapshotCharacter(name);
      if (snap) snapshots.push(snap);
    } catch {
      // A snapshot is advisory metadata. It must not stop a render that was already approved.
    }
  }
  if (snapshots.length > 0) job.characterSnapshots = snapshots;
}

const coverageLineSchema = z.object({
  text: z.string().optional(),
  delivery: z.enum(["spoken", "sung"]).optional(),
});

const coverageShotSchema = z.object({
  index: z.number().optional(),
  shotNumber: z.number().optional(),
  title: z.string().optional(),
  action: z.string().optional(),
  shotType: z.string().optional(),
  framing: z.string().optional(),
  durationSeconds: z.number().optional(),
  locationId: z.string().optional(),
  line: coverageLineSchema.optional(),
});

function toCoverageShot(
  raw: z.infer<typeof coverageShotSchema>,
  position: number,
): CoverageShot {
  const index = raw.index ?? raw.shotNumber ?? position + 1;
  const text = raw.line?.text?.trim();
  return {
    index,
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.shotType?.trim() ? { shotType: raw.shotType } : {}),
    ...(raw.framing?.trim() ? { framing: raw.framing } : {}),
    ...(typeof raw.durationSeconds === "number" ? { durationSeconds: raw.durationSeconds } : {}),
    ...(raw.locationId?.trim() ? { locationId: raw.locationId } : {}),
    ...(text
      ? {
        line: {
          text,
          ...(raw.line?.delivery ? { delivery: raw.line.delivery } : {}),
        },
        lineSource: "caller" as const,
      }
      : {}),
  };
}

function mergePlanShots(args: {
  plan?: {
    shots?: z.infer<typeof coverageShotSchema>[];
    continuity?: {
      shots?: Array<{ shot?: number; locationId?: string }>;
    };
  };
  beats?: z.infer<typeof coverageShotSchema>[];
  shots?: z.infer<typeof coverageShotSchema>[];
}): CoverageShot[] {
  const base = args.plan?.shots ?? args.shots ?? args.beats ?? [];
  return base.map((shot, position) => {
    const beat = args.beats?.[position];
    const merged = toCoverageShot({
      ...shot,
      ...(beat?.title && !shot.title ? { title: beat.title } : {}),
      ...(beat?.shotType && !shot.shotType ? { shotType: beat.shotType } : {}),
      ...(beat?.framing && !shot.framing ? { framing: beat.framing } : {}),
      ...(beat?.durationSeconds !== undefined && shot.durationSeconds === undefined
        ? { durationSeconds: beat.durationSeconds }
        : {}),
      ...(beat?.locationId && !shot.locationId ? { locationId: beat.locationId } : {}),
      ...(beat?.line && !shot.line ? { line: beat.line } : {}),
    }, position);
    if (!merged.locationId) {
      const fromLedger = args.plan?.continuity?.shots?.find((entry) => entry.shot === merged.index)?.locationId;
      if (fromLedger?.trim()) merged.locationId = fromLedger;
    }
    return merged;
  });
}

server.registerTool(
  "suggest_coverage",
  {
    description:
      "Suggest coverage, pacing, and ladder-order notes for a plan or a finished film. " +
      "Free and advisory: it does not render, spend, reorder shots, or approve anything. " +
      "A plan is the useful input, before anything is rendered. Shot type is never inferred from prompt text. " +
      "Caller-supplied beats are never corrected toward the built-in ladder. " +
      "Pass usedBuiltInLadder only when plan_storyboard built the plan from that ladder.",
    inputSchema: z.object({
      jobId: z.string().optional().describe("Read this film from disk. Ignored when a plan, shots, or beats are also passed."),
      usedBuiltInLadder: z.boolean().optional().describe(
        "True only when this plan came from the built-in ladder. Caller beats are never compared to that ladder.",
      ),
      targetDurationSeconds: z.number().positive().optional(),
      beats: z.array(coverageShotSchema).optional().describe(
        "Caller-supplied beats, in the caller's order. They are not reordered toward the built-in ladder.",
      ),
      shots: z.array(coverageShotSchema).optional(),
      plan: z.object({
        shots: z.array(coverageShotSchema).optional(),
        totalDurationSeconds: z.number().optional(),
        continuity: z.object({
          shots: z.array(z.object({
            shot: z.number().optional(),
            locationId: z.string().optional(),
          })).optional(),
        }).optional(),
      }).optional(),
    }),
  },
  async (args) => {
    if (beforeAdvisory) await beforeAdvisory();
    const callerPlan = Boolean(args.plan || args.shots || args.beats);
    if (!callerPlan && !args.jobId) {
      return refusal({
        version: 1,
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
        suggestions: [],
        error: "Pass a plan, shots, beats, or a jobId.",
      });
    }
    let shots: CoverageShot[];
    let source: "plan" | "job";
    let artifactPaths: string[];
    if (callerPlan) {
      shots = mergePlanShots(args);
      source = "plan";
      artifactPaths = ["caller-supplied"];
    } else {
      const job = await readPersistedJob(args.jobId ?? "");
      if (!job) {
        return refusal({
          version: 1,
          executed: false,
          willRender: false,
          willSpend: false,
          mutatedPaths: [],
          source: "job",
          suggestions: [],
          error: "Unknown jobId",
        });
      }
      shots = coverageShotsFromJob(job);
      source = "job";
      artifactPaths = [join(JOBS_DIR, `${job.id}.json`)];
    }
    if (shots.length === 0) {
      return refusal({
        version: 1,
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
        source,
        suggestions: [],
        error: "No shots to read.",
      });
    }
    const callerBeats = Boolean(args.beats && args.beats.length > 0);
    const report = suggestCoverage({
      shots,
      source,
      usedBuiltInLadder: args.usedBuiltInLadder === true && !callerBeats,
      callerSuppliedBeats: callerBeats,
      ...(args.targetDurationSeconds !== undefined ? { targetDurationSeconds: args.targetDurationSeconds } : {}),
      artifactPaths,
      ladder: BEAT_LADDER.map((beat) => ({ at: beat.at, title: beat.title })),
    });
    return refusal(report);
  },
);

async function filmsMatchingCharacter(name: string): Promise<CrossFilmJob[]> {
  let fileNames: string[] = [];
  try {
    fileNames = await readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const found: CrossFilmJob[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json") || fileName.startsWith(".")) continue;
    const full = join(JOBS_DIR, fileName);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(full, "utf8")) as unknown;
    } catch {
      continue;
    }
    const job = parseCrossFilmJob(value, full);
    if (!job) continue;
    const listed = job.settings?.characters?.some((entry) => namesMatch(entry, name)) ?? false;
    if (!listed) continue;
    found.push(job);
  }
  found.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  return found;
}

async function filmsById(ids: string[]): Promise<{
  jobs: CrossFilmJob[];
  missing: string[];
  invalid: Array<{ id: string; reason: string; path: string }>;
}> {
  const jobs: CrossFilmJob[] = [];
  const missing: string[] = [];
  const invalid: Array<{ id: string; reason: string; path: string }> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const full = join(JOBS_DIR, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(id);
        continue;
      }
      invalid.push({ id, reason: "unreadable", path: full });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      invalid.push({ id, reason: "invalid JSON", path: full });
      continue;
    }
    const job = parseCrossFilmJob(value, full);
    if (!job || !value || typeof value !== "object" || (value as { id?: unknown }).id !== id) {
      invalid.push({ id, reason: crossFilmParseError(value) || "job id does not match the file", path: full });
      continue;
    }
    jobs.push(job);
  }
  return { jobs, missing, invalid };
}

server.registerTool(
  "check_cross_film",
  {
    description:
      "Compare two to twenty films already on disk: character timestamps, first-shot wardrobe, " +
      "settings, location props, reference hashes, first frames, and resume or repair lineage. " +
      "Free and read-only. It does not render, spend, claim a film, or write a job file. " +
      "There is no series id. Pass jobIds, or a character name to select films that list that character. " +
      "A grayscale score is a 32x32 correlation, not a face match. persist writes one report outside the jobs directory " +
      "and lists that report path in mutatedPaths. The default writes nothing, and mutatedPaths is empty.",
    inputSchema: z.object({
      jobIds: z.array(z.string().min(1)).min(CROSS_FILM_MIN).max(CROSS_FILM_MAX).optional().describe(
        "Films to compare, 2 to 20. The order is the caller's.",
      ),
      character: z.string().min(1).optional().describe(
        "Select films whose settings.characters include this name. There is no series id.",
      ),
      persist: z.boolean().default(false).describe(
        "When true, write one report under the consistency directory. The default writes nothing.",
      ),
      intentionalWardrobeDifference: z.boolean().default(false).describe(
        "When true, a first-shot wardrobe difference is marked planned. It still does not change the films.",
      ),
    }),
  },
  async (args) => {
    if (beforeAdvisory) await beforeAdvisory();
    if (!args.jobIds && !args.character) {
      return refusal({
        version: 1,
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
        findings: [],
        films: [],
        persisted: false,
        error: "Pass jobIds or a character name.",
      });
    }
    let jobs: CrossFilmJob[];
    let missing: string[] = [];
    let invalidJobs: Array<{ id: string; reason: string; path?: string }> = [];
    if (args.jobIds) {
      const loaded = await filmsById(args.jobIds);
      jobs = loaded.jobs;
      missing = loaded.missing;
      invalidJobs = loaded.invalid;
      if (args.character) {
        jobs = jobs.filter((job) => job.settings?.characters?.some((name) => namesMatch(name, args.character ?? "")) ?? false);
      }
    } else {
      jobs = await filmsMatchingCharacter(args.character ?? "");
    }
    const characters = new Map<string, { name: string; updatedAt: string; path: string } | undefined>();
    for (const job of jobs) {
      for (const name of job.settings?.characters ?? []) {
        const key = name.trim().toLowerCase();
        if (characters.has(key)) continue;
        const record = await loadCharacter(name);
        characters.set(key, record
          ? { name: record.name, updatedAt: record.updatedAt, path: join(record.folder, "character.json") }
          : undefined);
      }
    }
    const pendingSpendUsd = new Map<string, number>();
    for (const job of jobs) {
      const queued = await readQueuedFilmSpend(job.id, job.spendLedger?.appliedNoteIds);
      pendingSpendUsd.set(job.id, queued.pendingSpendUsd);
    }
    const withinRange = jobs.length >= CROSS_FILM_MIN && jobs.length <= CROSS_FILM_MAX;
    let frameDir: string | undefined;
    const needsFrames = withinRange && jobs.some((job) => {
      const shot = job.shots?.[0];
      if (!shot?.localPath || !existsSync(shot.localPath)) return false;
      return !(shot.openingFramePath && existsSync(shot.openingFramePath));
    });
    if (needsFrames) {
      frameDir = await mkdtemp(join(JOBS_DIR, `.review-frames-${process.pid}-${hostKey()}-`));
      if (beforeAdvisoryFrames) await beforeAdvisoryFrames();
    }
    try {
      const report = await checkCrossFilm({
        jobs,
        missingJobIds: missing,
        invalidJobs,
        characters,
        pendingSpendUsd,
        intentionalWardrobeDifference: args.intentionalWardrobeDifference,
        fileExists: (file) => existsSync(file),
        filesIdentical,
        correlate: (left, right) => grayscaleStillCorrelation(left, right),
        resolveFirstFrame: async (job) => {
          const shot = job.shots?.[0];
          if (shot?.openingFramePath && existsSync(shot.openingFramePath)) {
            return { path: shot.openingFramePath, cited: shot.openingFramePath, ephemeral: false };
          }
          if (shot?.localPath && existsSync(shot.localPath) && frameDir) {
            const extracted = await extractFirstFrame(shot.localPath, frameDir);
            if (extracted) return { path: extracted, cited: shot.localPath, ephemeral: true };
          }
          return { cited: job.path, ephemeral: false };
        },
      });
      if (!args.persist || report.error) return refusal(report);
      const dir = consistencyDirectory();
      if (!consistencyDirIsSafe(dir, JOBS_DIR)) {
        return refusal({
          ...report,
          persisted: false,
          persistError: "Refusing to write a cross-film report inside the jobs directory.",
        });
      }
      const reportId = `cxf_${randomUUID()}`;
      const reportPath = join(dir, `${reportId}.json`);
      const body: CrossFilmReport & { reportId: string; reportPath: string } = {
        ...report,
        reportId,
        reportPath,
        persisted: true,
        mutatedPaths: [reportPath],
      };
      await atomicWriteFile(reportPath, JSON.stringify(body, null, 2));
      return refusal(body);
    } finally {
      if (frameDir) await rm(frameDir, { recursive: true, force: true });
    }
  },
);

server.registerTool(
  "production_feed",
  {
    description:
      "Read the production feed for films this plugin has recorded. Free, read-only, renders nothing, " +
      "spends nothing, writes nothing, and is never required for production. Poll it from any host. " +
      "Rendering, review, repair, and budget changes stay on the other tools.",
    inputSchema: z.object({
      cursor: z.string().optional().describe("Opaque cursor from the previous feed. A garbage cursor reads from the start."),
      limit: z.number().int().min(1).max(50).optional().describe("How many events to return. Defaults to 20."),
      jobId: z.string().optional().describe("One film. Any id that could leave the jobs directory is refused."),
    }),
    outputSchema: productionFeedResultSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    const feed = await readProductionFeed({
      jobsDir: JOBS_DIR,
      cursor: args.cursor,
      limit: args.limit,
      jobId: args.jobId,
    });
    if ("refused" in feed) {
      const refusal = {
        version: 1 as const,
        generatedAt: new Date().toISOString(),
        cursor: "",
        jobs: [],
        events: [],
        abstentions: [{ path: args.jobId ?? "", reason: feed.reason }],
        truncated: false,
      };
      const text = JSON.stringify(refusal, null, 2);
      return {
        isError: true,
        content: [{ type: "text" as const, text }],
        structuredContent: JSON.parse(text) as Record<string, unknown>,
      };
    }
    const text = JSON.stringify(feed, null, 2);
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: JSON.parse(text) as Record<string, unknown>,
    };
  },
);

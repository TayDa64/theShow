#!/usr/bin/env tsx
/**
 * theShow MCP Server (enhanced for testing)
 * - Stubs for most tools
 * - generate_controlled_clip calls the real Grok Imagine Video backend, through
 *   mcp/grokVideo.ts so the app's HTTP route shares the same implementation
 *
 * createTheShowServer builds the server and registers every tool.
 * startStdioServer is the desktop entry: it loads saved state, then connects
 * that server to stdio. mcp/launch.mjs and .mcp.json start this file with
 * THESHOW_TRANSPORT unset, so main() takes that path and opens no port.
 * THESHOW_TRANSPORT=http starts the Streamable HTTP transport instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveVideoCredential } from "./grok-auth.ts";
import {
  CLOSING_FRAME_MATCH_THRESHOLD,
  JOBS_DIR,
  OUTPUT_DIR,
  assembleClips,
  closingFrameAgreement,
  extractLastFrame,
  pathToDataUrl,
  probeDuration,
} from "./media.ts";
import {
  generateGrokClip,
  generateGrokStill,
  type GrokClipResult,
} from "./grokVideo.ts";
import { boardFilm, toRenderShots } from "./storyboard.ts";
import { loadCharacterSync, loadAllCharacters, saveCharacter } from "./characters.ts";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const CharacterSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  // Deliberately not z.string().url(): a local path or a chat attachment has to
  // reach toApiImageRef, which inlines it as a data URI. Zod's .url() rejects
  // "/workspace/photo.png", so the same reference worked on
  // generate_controlled_clip and failed here with no useful message.
  referenceImageUrls: z.array(z.string()).optional().describe(
    "Portrait reference images: public https URLs, data URIs, or local file paths. " +
    "Each is inlined for the API, so a path from a chat attachment or extract_last_frame works.",
  ),
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
const characterStore = new Map<string, {
  id: string;
  name: string;
  role?: string;
  description?: string;
  referenceImageUrls?: string[];
}>();

async function rememberCharacter(args: z.infer<typeof CharacterSchema>) {
  const key = args.name.trim().toLowerCase();
  const existing = characterStore.get(key) ?? loadCharacterSync(args.name.trim());

  // Save first: the record that comes back carries the copied reference paths,
  // which is what later renders need. Cache what was written, not what was asked
  // for, so the cache never claims a photo the disk does not have.
  const saved = await saveCharacter({
    name: args.name,
    role: args.role ?? existing?.role,
    description: args.description ?? existing?.description,
    referenceImageUrls: args.referenceImageUrls ?? existing?.referenceImageUrls,
  });

  const entry = {
    id: saved.id,
    name: saved.name,
    role: saved.role,
    description: saved.description,
    referenceImageUrls: saved.referenceImageUrls,
  };
  characterStore.set(key, entry);
  return { entry, folder: saved.folder, warnings: saved.warnings };
}

function lookupCharacter(name: string) {
  const key = name.trim().toLowerCase();
  const cached = characterStore.get(key);
  if (cached) return cached;

  // Lazy fallback so a character made in an earlier session is usable now,
  // whether or not the startup load ran. Synchronous because plan_storyboard and
  // mergeCharacterReferences are: one small JSON file on a cache miss is cheaper
  // than making every caller async.
  const fromDisk = loadCharacterSync(name);
  if (!fromDisk) return undefined;
  characterStore.set(key, {
    id: fromDisk.id,
    name: fromDisk.name,
    role: fromDisk.role,
    description: fromDisk.description,
    referenceImageUrls: fromDisk.referenceImageUrls,
  });
  return characterStore.get(key);
}

/** Pull every saved character into the cache so lookups start warm. */
async function loadCharactersFromDisk() {
  try {
    for (const character of await loadAllCharacters()) {
      characterStore.set(character.name.trim().toLowerCase(), {
        id: character.id,
        name: character.name,
        role: character.role,
        description: character.description,
        referenceImageUrls: character.referenceImageUrls,
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
const BEAT_LADDER = [
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

type ShotBeat = { title: string; action: string; note?: string };

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
      shotType: i === 0 ? "wide" : "medium",
      durationSeconds: per,
      action: beat.action.replace(/\{scene\}/g, scene).replace(/\{character\}/g, cast[0]),
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
  const never = String(v.neverShow ?? "").trim();

  parts.push(`Maintain exactly across every shot: ${style ? `${style} look` : "the same look"}.`);
  if (characters) parts.push(`Cast, unchanged in every shot: ${characters}.`);
  if (audio) parts.push(`Audio: ${audio.toLowerCase()}. No music unless asked for.`);
  if (never) parts.push(`Never show: ${never}.`);
  parts.push("Keep the same light source, palette and set dressing as the previous shot.");
  return parts.join(" ");
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
        "Attach the track in chat and paste its path here, or use an https link. It is mixed " +
        "under the film, looped if short and faded out at the end. Leave blank for no music.",
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

function registerConfigureFilm(server: McpServer) {
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
  async (args) => {
    const title = args.prompt ?? "Configure the film";

    const caps = server.server.getClientCapabilities();
    const canElicit = Boolean(caps?.elicitation);

    if (!canElicit) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            elicitationSupported: false,
            message:
              "This client cannot show an interactive form, so ask for these fields conversationally " +
              "in one message rather than one at a time.",
            fields: Object.entries(FILM_FORM_SCHEMA.properties).map(([key, v]) => ({
              key,
              title: (v as { title?: string }).title ?? key,
              description: (v as { description?: string }).description ?? "",
            })),
          }, null, 2),
        }],
      };
    }

    const schema = structuredClone(FILM_FORM_SCHEMA) as typeof FILM_FORM_SCHEMA;
    if (args.scene) schema.properties.scene = { ...schema.properties.scene, default: args.scene };

    let result;
    try {
      result = await server.server.elicitInput({
        message: title,
        requestedSchema: schema,
      } as Parameters<typeof server.server.elicitInput>[0]);
    } catch (err) {
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
              `${shotCount} renders x ${shotSeconds}s at about $0.14/s, the 720p rate. ` +
              `480p runs near $0.08/s and 1080p near $0.25/s.`,
            isEstimate: true,
          },
          continuityBlock: buildContinuityBlock(v),
          next:
            "Show this back for a yes, then call plan_storyboard, and create_character with " +
            "referenceImageUrls if a reference image was given. Pass continuityBlock as " +
            "render_sequence's `continuity` so every shot carries the same set, wardrobe and " +
            "constraints, and audioTrack as `audioTrackUrl`. Never invent a character detail the " +
            "user left blank.",
        }, null, 2),
      }],
    };
  }
);
}


function registerCreateCharacter(server: McpServer) {
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
          referenceImages: entry.referenceImageUrls.length,
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
}


function registerPlanStoryboard(server: McpServer) {
server.registerTool(
  "plan_storyboard",
  {
    description: "Plan multi-shot storyboard for a scene.",
    inputSchema: z.object({
      sceneDescription: z.string(),
      beats: z.array(z.object({
        title: z.string(),
        action: z.string().describe("What happens in this shot. {scene} and {character} are substituted."),
        note: z.string().optional().describe("Continuity requirement carried into the prompt."),
      })).optional().describe(
        "Your own story beats, one per shot. Overrides the built-in six-beat ladder, which is only " +
        "a default shape and must not be imposed on a story the user already described.",
      ),
      characters: z.array(z.string()),
      targetDurationSeconds: z.number().optional(),
      shotCount: z.number().optional(),
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

    const unknown = (args.characters ?? []).filter((name) => !lookupCharacter(name));
    const payload: Record<string, unknown> = {
      scene: args.sceneDescription,
      shotCount: shots.length,
      totalDurationSeconds: shots.reduce((sum, shot) => sum + (shot.durationSeconds as number), 0),
      shots,
    };
    if (unknown.length > 0) {
      payload.note = `No stored character record for: ${unknown.join(", ")}. Call create_character first so continuity notes can carry wardrobe and reference images.`;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    };
  }
);
}


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
const PERSON_IN_SHOT =
  /\b(he|she|they|him|her|them|his|hers|their|theirs|man|woman|figure|person|child|boy|girl|guy|lady|face|head|eyes?|beard|hair|hands?|arms?|shoulders?|expression|smiles?|nods?|turns?|walks?|sits?|stands?|strides?|gestures?)\b/i;

function mentionsPerson(text: string) {
  return PERSON_IN_SHOT.test(text);
}

function composeShotPrompt(continuity: string | undefined, prompt: string) {
  const anchor = continuity?.trim();
  const shot = prompt.trim();
  if (!anchor) return shot;
  return `${anchor}

Shot: ${shot}`;
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
  /** Pinned final frame. With firstFrameUrl as well, the shot is bookended. */
  lastFrameUrl?: string;
};

/** Uniform shape so callers can read optional fields without narrowing gymnastics. */
type ClipResult = Omit<GrokClipResult, "status"> & { status?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


function registerGenerateControlledClip(server: McpServer) {
server.registerTool(
  "generate_controlled_clip",
  {
    description:
      "Generate a single video clip with reference images and optional first-frame continuity. " +
      "Uses a real Grok Imagine Video backend, authenticating with XAI_API_KEY when present or " +
      "falling back to the Grok CLI session in ~/.grok/auth.json so calls bill to the Grok subscription.",
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
          "Image to pin as the last rendered frame: public https URL, a data URI, or a local path " +
          "from extract_last_frame. Together with firstFrameUrl it bookends the shot, so a cut to " +
          "the next shot lands on identical pixels instead of two near-misses. Use the next shot's " +
          "firstFrameUrl as this frame and the join is the same picture.",
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
    }),
  },
  async (args) => {
    const { waitForCompletion, timeoutSeconds, characters, ...rest } = args;
    const job: VideoJob = { ...rest };

    const { urls, missing } = mergeCharacterReferences(characters, rest.referenceImageUrls);
    job.referenceImageUrls = urls.length > 0 ? urls : undefined;

    const result = await generateGrokClip(job, { waitForCompletion, timeoutSeconds });
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
          args,
        }, null, 2)
      }]
    };
  }
);
}


function registerExtendClip(server: McpServer) {
server.registerTool(
  "extend_clip",
  {
    description:
      "Extend an existing clip from its last frame, producing one longer continuous take. " +
      "Requires a clip of 2-15 seconds and an extension of 2-10 seconds. " +
      "Only available with an XAI_API_KEY: the subscription session proxy does not expose the " +
      "extensions route, so on the session path this reports that clearly instead of guessing.",
    inputSchema: z.object({
      videoUrl: z.string().describe("Public https URL of the source clip (2-15 seconds)."),
      prompt: z.string(),
      durationSeconds: z.number().min(2).max(10).default(6),
      model: z.string().default("grok-imagine-video"),
      waitForCompletion: z.boolean().default(true),
      timeoutSeconds: z.number().min(10).max(600).default(240),
    }),
  },
  async (args) => {
    const resolved = resolveVideoCredential();
    if (resolved.ok === false) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No credential", reason: resolved.reason }, null, 2) }] };
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
            auth: credential.source,
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
          text: JSON.stringify({ error: `API error ${submitRes.status}`, detail: await submitRes.text(), auth: credential.source }, null, 2),
        }],
      };
    }
    const submitted = (await submitRes.json()) as { request_id?: string };
    const requestId = submitted.request_id;
    if (!requestId) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No request_id returned" }, null, 2) }] };
    }

    if (!args.waitForCompletion) {
      return { content: [{ type: "text", text: JSON.stringify({ requestId, status: "submitted", statusUrl: `${credential.baseUrl}/v1/videos/${requestId}` }, null, 2) }] };
    }

    const deadline = Date.now() + args.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const statusRes = await fetch(`${credential.baseUrl}/v1/videos/${requestId}`, { headers });
      if (!statusRes.ok) continue;
      const poll = (await statusRes.json()) as { status?: string; video?: { url?: string; duration?: number } };
      if (poll.status === "done" || poll.status === "completed") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              requestId,
              status: "completed",
              videoUrl: poll.video?.url,
              durationSeconds: poll.video?.duration,
              extendedBy: args.durationSeconds,
              auth: credential.source,
            }, null, 2),
          }],
        };
      }
      if (poll.status === "failed" || poll.status === "expired") {
        return { content: [{ type: "text", text: JSON.stringify({ requestId, status: poll.status, detail: poll }, null, 2) }] };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ requestId, status: "timeout", statusUrl: `${credential.baseUrl}/v1/videos/${requestId}` }, null, 2) }] };
  }
);
}


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

function registerExtractLastFrame(server: McpServer) {
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
}


/**
 * Generate one still image. This is the cheap half of the pipeline and the thing
 * that makes a stills-first workflow possible: at two cents a still, boarding an
 * eight-shot film is about eighteen cents against roughly nine dollars of 720p
 * footage, so the pictures can be reviewed before the expensive half runs.
 */
function registerGenerateStill(server: McpServer) {
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
      characters: z.array(z.string()).optional().describe(
        "Names of characters created with create_character. Their reference images are merged " +
        "into referenceImageUrls automatically.",
      ),
    }),
  },
  async (args) => {
    const { urls, missing } = mergeCharacterReferences(args.characters, args.referenceImageUrls);
    const result = await generateGrokStill(
      {
        prompt: args.prompt,
        aspectRatio: args.aspectRatio,
        referenceImageUrls: urls.length > 0 ? urls : undefined,
      },
      { outputDir: OUTPUT_DIR },
    );

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
          auth: result.auth,
          referenceImagesUsed: urls.length,
          unknownCharacters: missing.length > 0 ? missing : undefined,
          message:
            "Pass imagePath as firstFrameUrl or lastFrameUrl on generate_controlled_clip, or as a " +
            "reference. board_film does a whole film's frames in one call.",
        }, null, 2),
      }],
    };
  }
);
}


function registerAssembleFilm(server: McpServer) {
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
        "or a local path such as a chat attachment. Looped if shorter than the film, trimmed to " +
        "its length, and faded out at the end. Mixed under the clips' own audio, never replacing it.",
      ),
      audioTrackVolume: z.number().min(0.01).max(4).default(0.25).describe(
        "Bed level. 0.25 sits under dialogue; 1.0 is a full-volume music video.",
      ),
      audioTrackFadeOutSeconds: z.number().min(0).max(30).default(1.5),
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
type SequenceJob = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "completed" | "stopped" | "failed";
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

async function persistJob(job: SequenceJob) {
  try {
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
  } catch (err) {
    // A failed write must never lose the render. The job is already in memory,
    // and the next state change tries again.
    console.error(`theShow: could not persist job ${job.id}:`, err);
  }
}

async function loadJobsFromDisk() {
  try {
    const files = await readdir(JOBS_DIR);
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(JOBS_DIR, name), "utf8");
        const job = JSON.parse(raw) as SequenceJob;
        if (!job?.id) continue;
        // A job that was mid-render when the server died cannot be resumed by
        // polling: nothing is driving it. Mark it honestly rather than leaving
        // it "running" forever.
        if (job.state === "running") {
          job.state = "stopped";
          job.error =
            "The server stopped while this film was rendering. Shots already finished are kept; " +
            "the rest were never rendered.";
          job.finishedAt = job.finishedAt ?? Date.now();
          void persistJob(job);
        }
        sequenceJobs.set(job.id, job);
      } catch {
        // One unreadable file must not stop the others from loading.
      }
    }
  } catch {
    // No jobs directory yet: a first run.
  }
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
      const anchored = mentionsPerson(prompt)
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
        referenceImageUrls: characterRefs.length > 0 ? Array.from(new Set(characterRefs)) : undefined,
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
          referenceImageUrls: characterRefs.length > 0 ? Array.from(new Set(characterRefs)) : undefined,
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
        lastFrameUrl: shot.lastFrameUrl,
        lastFramePath: localImagePath(shot.lastFrameUrl),
        prompt: shot.prompt,
        durationSeconds: shot.durationSeconds,
      };
      job.spentUsd += result.costUsd ?? 0;
      job.shots.push(entry);

      if (result.status !== "completed" || !result.videoUrl) {
        job.state = "stopped";
        job.error = `Shot ${shotNumber} failed: ${result.error ?? "no video URL returned"}. The chain stopped so no later shot renders without continuity.`;
        job.finishedAt = Date.now();
        void persistJob(job);
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
        void persistJob(job);
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
    void persistJob(job);
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    void persistJob(job);
  }
}

function registerRenderSequence(server: McpServer) {
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
          "Pinned closing frame for this shot. With firstFrameUrl the shot is bookended, and if " +
          "it equals the next shot's firstFrameUrl the cut between them lands on identical pixels. " +
          "board_film fills this in for a whole film.",
        ),
      })).min(1).max(12).describe("Shots in order, 1 to 12. More than that is usually two films."),
      characters: z.array(z.string()).optional().describe(
        "Character names from create_character. Their reference images go on every shot.",
      ),
      continuity: z.string().optional().describe(
        "Everything that must stay identical across the film, written once: set, wardrobe, light " +
        "source, palette, and the negative constraints. It is prepended to every shot prompt, so " +
        "you never have to repeat it and the model cannot forget it. configure_film returns a " +
        "ready-made block for this.",
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
      audioTrackVolume: z.number().min(0.01).max(4).default(0.25),
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
    }),
  },
  async (args) => {
    const shotCount = args.shots.length;
    const totalSeconds = args.shots.reduce((sum, s) => sum + s.durationSeconds, 0);

    // Resolve a resume target up front so a bad id fails before anything spends.
    let resumeJob: SequenceJob | undefined;
    if (args.resumeFromJobId) {
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
              continuity: bookendedShots > 0
                ? `${bookendedShots} of ${shotCount} shots are bookended with explicit first and ` +
                  "last frames; the rest chain from the previous shot's last frame."
                : "Each shot starts from the previous shot's last frame.",
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
                `${shotCount} renders totalling ${totalSeconds}s at about ` +
                `$${ratePerSecond(args.resolution).toFixed(2)}/s for ${args.resolution}, from measured 8s runs`,
              isEstimate: true,
            },
            ...(resumeWarnings.length > 0 ? { warnings: resumeWarnings } : {}),
            next:
              "Show this to the user. Call again with confirm: true only after they approve. Do not " +
              "set confirm without an explicit yes.",
          }, null, 2),
        }],
      };
    }

    const job: SequenceJob = {
      id: sequenceJobId(),
      startedAt: Date.now(),
      state: "running",
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
        audioTrackFile: args.audioTrackUrl ? await resolveToLocalFile(args.audioTrackUrl) : undefined,
        audioTrackVolume: args.audioTrackVolume,
        audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
        assemble: args.assemble,
      },
      ...(resumeJob ? {
        resumedFrom: { jobId: resumeJob.id, fromShot: carried.length },
        carriedOverUsd: Math.round(carried.reduce((sum, s) => sum + (s.costUsd ?? 0), 0) * 100) / 100,
        // A continued film keeps the original start anchor, so repairing shot 1
        // of the whole film still chains from where the film actually began.
        startFramePath: resumeJob.startFramePath,
        warnings: resumeJob.warnings ? [...resumeJob.warnings] : undefined,
      } : {
        startFramePath: resumeFramePath ?? args.firstFrameUrl,
      }),
    };
    sequenceJobs.set(job.id, job);
    void persistJob(job);

    // Deliberately not awaited: a multi-shot chain outlives the client's request
    // timeout, and awaiting it turns a finished film into a timeout error.
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
      // Resolved once, up front, so a bad path fails before any shot renders.
      audioTrackFile: args.audioTrackUrl ? await resolveToLocalFile(args.audioTrackUrl) : undefined,
      audioTrackVolume: args.audioTrackVolume,
      audioTrackFadeOutSeconds: args.audioTrackFadeOutSeconds,
      timeoutSecondsPerShot: args.timeoutSecondsPerShot,
      carriedShots: carried.length > 0 ? carried : undefined,
      resumeFramePath,
    });

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
      }, null, 2) }],
    };
  }
);
}


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
function registerBoardFilm(server: McpServer) {
server.registerTool(
  "board_film",
  {
    description:
      "Board a film as stills before rendering it: generate one image per shot boundary, so " +
      "consecutive shots share a frame and every cut lands on identical pixels. Two cents a still " +
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
      })).min(1).max(12).describe(
        "Shots in order. N shots produce N+1 stills, because the boundary between two shots is " +
        "one picture shared by both.",
      ),
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
        "user, and call again with true only after they approve.",
      ),
    }),
  },
  async (args) => {
    const { urls, missing } = mergeCharacterReferences(args.characters, args.referenceImageUrls);
    // Default the base to a Location character unless the caller named one.
    const baseImageUrl = args.baseImageUrl ?? findLocationBase(args.characters);

    const board = await boardFilm(
      {
        shots: args.shots,
        aspectRatio: args.aspectRatio,
        look: args.look,
        cast: args.cast,
        maxCostUsd: args.maxCostUsd,
        confirm: args.confirm,
      },
      {
        outputDir: OUTPUT_DIR,
        // A base image and a reference set compete for the same body, and the
        // base is worth more: it holds the room. Keep the portraits that are
        // not the base itself.
        referenceImageUrls: urls.length > 0
          ? urls.filter((url) => url !== baseImageUrl)
          : undefined,
        baseImageUrl,
        // Injected so tests can board a whole film without reaching the network.
        generateStill: async (job, opts) => generateGrokStill(job, opts),
      },
    );

    // A gate that reports what it refused to spend has to say so plainly: the
    // one thing this tool must never do is spend past the caller's ceiling.
    const payload = {
      ...board,
      ...(missing.length > 0 ? { unknownCharacters: missing } : {}),
      ...(board.action === "boarded" || board.action === "partial"
        ? { renderShots: toRenderShots(board) }
        : {}),
    };

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);
}


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
function registerRetryShot(server: McpServer) {
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
      timeoutSecondsPerShot: z.number().min(10).max(600).default(240),
    }),
  },
  async (args) => {
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
    const estimateUsd = Math.round(duration * ratePerSecond(original.settings?.resolution ?? "720p") * 100) / 100;

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
              resolution: original.settings?.resolution ?? "720p",
              basis: `1 render of ${duration}s at the film's original resolution`,
              isEstimate: true,
            },
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
            next: "Show this and the caveat to the user. Call again with confirm: true only after they approve.",
          }, null, 2),
        }],
      };
    }

    const settings = original.settings;
    const job: SequenceJob = {
      id: sequenceJobId(),
      startedAt: Date.now(),
      state: "running",
      shotCount: original.shots.length,
      completed: before.length,
      estimateUsd,
      spentUsd: 0,
      shots: [],
      settings,
      startFramePath: original.startFramePath,
      warnings: [...(original.warnings ?? [])],
      repairedFrom: { jobId: original.id, shotIndex: index, originalCostUsd: target.costUsd },
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

    sequenceJobs.set(job.id, job);
    void persistJob(job);

    void runSequenceJob(job, {
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
    });

    const inlineDeadline = Date.now() + 25_000;
    while (Date.now() < inlineDeadline && job.state === "running" && job.shots.length === before.length) {
      await sleep(500);
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        action: job.state === "running" ? "started" : job.state,
        ...jobPayload(job),
      }, null, 2) }],
    };
  }
);
}


/**
 * List the films this user has made, newest first.
 *
 * Read-only and free. The point is that a film is no longer trapped in the
 * session that rendered it: come back a week later and the job id, the shot
 * count, the cost and the file are all still there to continue or repair.
 */
function registerListFilms(server: McpServer) {
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
    const all = Array.from(sequenceJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
    const shown = all
      .filter((job) => args.includeUnfinished || job.state === "completed")
      .slice(0, args.limit)
      .map((job) => ({
        jobId: job.id,
        state: job.state,
        startedAt: new Date(job.startedAt).toISOString(),
        shots: job.shots.length,
        durationSeconds: job.filmDurationSeconds,
        spentUsd: Math.round(job.spentUsd * 100) / 100,
        filmPath: job.filmPath,
        firstShot: job.shots[0]?.title,
        repaired: job.repairedFrom ? `replaced shot ${job.repairedFrom.shotIndex} of ${job.repairedFrom.jobId}` : undefined,
        error: job.error,
      }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          count: shown.length,
          films: shown,
          storage: JOBS_DIR,
          next: shown.length === 0
            ? "No films yet. Configure one with configure_film, then render_sequence."
            : "Pass a jobId to render_sequence as resumeFromJobId to extend that film, or to " +
              "retry_shot to replace one of its shots.",
        }, null, 2),
      }],
    };
  }
);
}

/**
 * Poll a render_sequence job.
 *
 * Separate tool rather than a second mode on render_sequence, so polling can
 * never be mistaken for a new render and never spends anything.
 */
function registerCheckSequence(server: McpServer) {
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
    const job = sequenceJobs.get(args.jobId);
    if (!job) {
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
    return {
      content: [{ type: "text", text: JSON.stringify(jobPayload(job), null, 2) }],
    };
  }
);
}

/**
 * Build the MCP server and register every tool.
 *
 * The transport is the caller's choice. The character cache and the film-job
 * map stay module-level, created when this file loads, so every server built
 * here closes over the same stores the desktop process has always used.
 */
export function createTheShowServer(): McpServer {
  const server = new McpServer({
    name: "theshow",
    version: "0.1.0",
  });
  registerConfigureFilm(server);
  registerCreateCharacter(server);
  registerPlanStoryboard(server);
  registerGenerateControlledClip(server);
  registerExtendClip(server);
  registerExtractLastFrame(server);
  registerGenerateStill(server);
  registerAssembleFilm(server);
  registerRenderSequence(server);
  registerBoardFilm(server);
  registerRetryShot(server);
  registerListFilms(server);
  registerCheckSequence(server);
  return server;
}

/**
 * Desktop entry point. Load films and characters saved by earlier sessions,
 * then speak MCP over stdio. mcp/launch.mjs and .mcp.json start this path.
 */
export async function startStdioServer(): Promise<void> {
  // Load films saved by earlier sessions before taking requests, so a user who
  // comes back tomorrow can still continue or repair what they paid for.
  await loadJobsFromDisk();
  // Same reason for the cast: a character created last week, with the photos
  // that make it that character, has to be here for today's film.
  await loadCharactersFromDisk();
  const server = createTheShowServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("theShow MCP server running on stdio (enhanced test build)");
}

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
/** Same ceiling the SDK uses when it reads a POST body itself. */
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

type TransportName = "stdio" | "http";

type HttpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closing: boolean;
};

/**
 * Which transport this process speaks. Unset means stdio, which is the
 * desktop plugin: .mcp.json never sets this, and that launch must not listen.
 */
function selectedTransport(): TransportName {
  const raw = process.env.THESHOW_TRANSPORT;
  if (raw === undefined || raw === "") return "stdio";
  switch (raw) {
    case "stdio":
    case "http":
      return raw;
    default:
      throw new Error(
        `THESHOW_TRANSPORT must be "stdio" or "http" (got ${JSON.stringify(raw)}).`,
      );
  }
}

function requireHttpToken(): string {
  const token = process.env.THESHOW_HTTP_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error(
      "THESHOW_HTTP_TOKEN is required when THESHOW_TRANSPORT=http. " +
        "Refusing to start an HTTP server without a bearer token.",
    );
  }
  return token;
}

function httpBind(): { host: string; port: number } {
  const host = process.env.THESHOW_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
  const raw = process.env.THESHOW_HTTP_PORT?.trim() || String(DEFAULT_HTTP_PORT);
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `THESHOW_HTTP_PORT must be an integer from 0 to 65535 (got ${JSON.stringify(process.env.THESHOW_HTTP_PORT)}).`,
    );
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new Error(`THESHOW_HTTP_PORT must be an integer from 0 to 65535 (got ${port}).`);
  }
  return { host, port };
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bearerAuthorized(authorization: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const presented = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(token);
  if (presented.length === 0 || presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readHttpBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (err?: Error & { code?: string }) => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      if (err) reject(err);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        const err = Object.assign(new Error("too large"), { code: "TOO_LARGE" });
        finish(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => finish(err);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function messageInitializes(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((entry) => isInitializeRequest(entry));
  return isInitializeRequest(body);
}

/**
 * Remote entry point. One MCP server and one Streamable HTTP transport per
 * session. The character cache and the film-job map stay the module-level
 * stores createTheShowServer already closes over, so a second session in this
 * process sees the same cast and the same films.
 *
 * Saved state is loaded once, here, before listen. Loading it again per
 * session would re-run the "running job becomes stopped" rule and mark a live
 * render as stopped just because someone connected.
 *
 * Closing a session closes that session's transport only. It does not touch
 * sequenceJobs, so a client disconnect or DELETE cannot cancel a render that
 * runSequenceJob is already driving.
 */
export async function startHttpServer(): Promise<void> {
  const token = requireHttpToken();
  const { host, port } = httpBind();
  await loadJobsFromDisk();
  await loadCharactersFromDisk();

  const sessions = new Map<string, HttpSession>();

  async function retire(session: HttpSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    const id = session.transport.sessionId;
    if (id) sessions.delete(id);
    try {
      await session.server.close();
    } catch (err) {
      console.error("theShow: failed to close MCP session:", err);
    }
  }

  async function openSession(): Promise<HttpSession> {
    let session: HttpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
      onsessionclosed: () => retire(session),
    });
    session = {
      server: createTheShowServer(),
      transport,
      closing: false,
    };
    transport.onclose = () => {
      if (session.closing) return;
      void retire(session);
    };
    transport.onerror = (error) => {
      console.error("theShow HTTP session error:", error);
    };
    await session.server.connect(transport);
    return session;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      writeJson(res, 404, rpcError(-32001, "Not found. The MCP endpoint is /mcp."));
      req.resume();
      return;
    }

    // Before any JSON-RPC method, including initialize and tools/call.
    if (!bearerAuthorized(singleHeader(req, "authorization"), token)) {
      writeJson(res, 401, rpcError(-32000, "Unauthorized"), {
        "WWW-Authenticate": "Bearer",
      });
      req.resume();
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      writeJson(res, 405, rpcError(-32000, "Method not allowed."), {
        Allow: "GET, POST, DELETE",
      });
      req.resume();
      return;
    }

    let parsedBody: unknown;
    if (req.method === "POST") {
      let raw: Buffer;
      try {
        raw = await readHttpBody(req, MAX_HTTP_BODY_BYTES);
      } catch (err) {
        if ((err as { code?: string }).code === "TOO_LARGE") {
          writeJson(res, 413, rpcError(-32000, "Request body too large"));
          return;
        }
        throw err;
      }
      try {
        parsedBody = JSON.parse(raw.toString("utf8"));
      } catch {
        writeJson(res, 400, rpcError(-32700, "Parse error: Invalid JSON"));
        return;
      }
    }

    const sessionId = singleHeader(req, "mcp-session-id");
    if (!sessionId && req.method === "POST" && messageInitializes(parsedBody)) {
      const session = await openSession();
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } finally {
        const id = session.transport.sessionId;
        if (!id || !sessions.has(id)) await retire(session);
      }
      return;
    }

    if (!sessionId) {
      writeJson(res, 400, rpcError(-32000, "Bad Request: No valid session ID provided"));
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      writeJson(res, 404, rpcError(-32001, "Session not found"));
      return;
    }

    await existing.transport.handleRequest(
      req,
      res,
      req.method === "POST" ? parsedBody : undefined,
    );
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch((err) => {
      console.error("theShow: HTTP request failed:", err);
      writeJson(res, 500, rpcError(-32603, "Internal server error"));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    httpServer.once("error", onListenError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onListenError);
      const bound = httpServer.address();
      const boundPort = typeof bound === "object" && bound ? bound.port : port;
      console.error(
        `theShow MCP server running on http://${formatHost(host)}:${boundPort}/mcp`,
      );
      resolve();
    });
  });

  const shutdown = () => {
    httpServer.close();
    for (const session of sessions.values()) void retire(session);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main() {
  const transport = selectedTransport();
  switch (transport) {
    case "stdio":
      await startStdioServer();
      return;
    case "http":
      await startHttpServer();
      return;
    default: {
      const unexpected: never = transport;
      throw new Error(`Unhandled transport ${unexpected}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

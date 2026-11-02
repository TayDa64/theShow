#!/usr/bin/env tsx
/**
 * theShow MCP Server (enhanced for testing)
 * - Stubs for most tools
 * - generate_controlled_clip calls the real Grok Imagine Video backend, through
 *   mcp/grokVideo.ts so the app's HTTP route shares the same implementation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveVideoCredential } from "./grok-auth.ts";
import { assembleClips, extractLastFrame, pathToDataUrl, probeDuration } from "./media.ts";
import { generateGrokClip, type GrokClipResult } from "./grokVideo.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const server = new McpServer({
  name: "theshow",
  version: "0.1.0",
});

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

/** Characters created in this process, so storyboards can use their real context. */
const characterStore = new Map<string, {
  id: string;
  name: string;
  role?: string;
  description?: string;
  referenceImageUrls?: string[];
}>();

function rememberCharacter(args: z.infer<typeof CharacterSchema>) {
  const key = args.name.trim().toLowerCase();
  const existing = characterStore.get(key);
  const entry = {
    id: existing?.id ?? `char_${Date.now()}_${characterStore.size}`,
    name: args.name.trim(),
    role: args.role ?? existing?.role,
    description: args.description ?? existing?.description,
    referenceImageUrls: args.referenceImageUrls ?? existing?.referenceImageUrls,
  };
  characterStore.set(key, entry);
  return entry;
}

function lookupCharacter(name: string) {
  return characterStore.get(name.trim().toLowerCase());
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
      shot.continuityNotes = `${beat.note} Uses the last frame of shot ${i} as first_frame.`;
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
    // The form cannot know the resolution yet, so quote the 720p rate and say so;
    // quoting the 480p rate made every estimate look a third cheaper than the
    // render it was describing.
    const perShot = Math.round(shotSeconds * 0.14 * 100) / 100;
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
            aspectRatio: v.aspectRatio ?? "16:9",
            audio: v.audio ?? "Diegetic only",
            neverShow: v.neverShow ?? "",
            referenceImage: v.referenceImage || undefined,
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
            "constraints. Never invent a character detail the user left blank.",
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
    const stored = rememberCharacter(args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...stored,
          message: "Character created and held in this session's store; plan_storyboard can now use it for continuity."
        }, null, 2)
      }]
    };
  }
);

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

/**
 * Build the prompt actually sent for a shot.
 *
 * The renderer has no memory between calls, so anything that has to stay the
 * same across the film has to be in every single prompt. Relying on the model
 * to copy wardrobe and set details forward is how half a film ends up with the
 * wrong coat. `continuity` is written once and prepended here.
 */
function composeShotPrompt(continuity: string | undefined, prompt: string) {
  const anchor = continuity?.trim();
  if (!anchor) return prompt;
  return `${anchor}

Shot: ${prompt.trim()}`;
}

type VideoJob = {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  model?: string;
  referenceImageUrls?: string[];
  firstFrameUrl?: string;
};

/** Uniform shape so callers can read optional fields without narrowing gymnastics. */
type ClipResult = Omit<GrokClipResult, "status"> & { status?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


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

    // Fold registered character portraits into the reference list. Without this
    // the references sit in the store while the render runs blind, which is
    // exactly how a film drifts off the character the user supplied.
    const fromCharacters: string[] = [];
    const missing: string[] = [];
    for (const name of characters ?? []) {
      const known = lookupCharacter(name);
      if (!known) { missing.push(name); continue; }
      fromCharacters.push(...(known.referenceImageUrls ?? []));
    }
    const merged = [...(rest.referenceImageUrls ?? []), ...fromCharacters];
    job.referenceImageUrls = merged.length > 0 ? Array.from(new Set(merged)) : undefined;

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

const DOWNLOAD_DIR = process.env.THESHOW_OUTPUT_DIR || join(tmpdir(), "theshow-output");

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
      "Extract the last frame of a video as a PNG for use as first_frame on the next shot. " +
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
    }),
  },
  async (args) => {
    const localFiles = [];
    for (const clip of args.clips) {
      const file = await resolveToLocalFile(clip.url);
      localFiles.push({ file, trimStart: clip.trimStart, trimEnd: clip.trimEnd });
    }

    const result = await assembleClips({ clips: localFiles, fadeDuration: args.fadeDuration });
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
      message:
        result.mode === "xfade"
          ? "Film assembled with cross-fades."
          : "Film assembled with hard cuts.",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("theShow MCP server running on stdio (enhanced test build)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
  }>;
  /** Set when this job continued an earlier one, so cost and provenance stay honest. */
  resumedFrom?: { jobId: string; fromShot: number };
  carriedOverUsd?: number;
  filmPath?: string;
  fileUrl?: string;
  filmDurationSeconds?: number;
  filmBytes?: number;
  lastFramePath?: string;
  unknownCharacters?: string[];
  error?: string;
};

const sequenceJobs = new Map<string, SequenceJob>();

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
      shots: job.shots,
      filmPath: job.filmPath,
      fileUrl: job.fileUrl,
      filmDurationSeconds: job.filmDurationSeconds,
      filmBytes: job.filmBytes,
      lastFramePath: job.lastFramePath,
      unknownCharacters: job.unknownCharacters?.length ? job.unknownCharacters : undefined,
      error: job.error,
    } : {
      spentUsdSoFar: Math.round(job.spentUsd * 100) / 100,
      message: "Still rendering. Poll check_sequence with this jobId.",
    }),
    next: job.state === "completed"
      ? "Report the filmPath and spentUsd to the user. To make the film longer, call " +
        "render_sequence again with resumeFromJobId set to this jobId and only the new shots."
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
    shots: Array<{ prompt: string; durationSeconds: number; title?: string }>;
    characters?: string[];
    continuity?: string;
    firstFrameUrl?: string;
    aspectRatio: string;
    resolution: string;
    model: string;
    assemble: boolean;
    fadeDuration: number;
    timeoutSecondsPerShot: number;
    /**
     * Shots already rendered by an earlier job, in order, kept on the front of
     * the film. Their clips go into the final assembly so continuing a film
     * assembles the whole thing instead of just the tail.
     */
    carriedShots?: SequenceJob["shots"];
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
  job.shots.push(...carried);
  job.completed = carried.length;

  let previousFrame: string | undefined =
    args.resumeFramePath ?? carried.at(-1)?.framePath ?? args.firstFrameUrl;
  if (previousFrame) job.lastFramePath = previousFrame;

  try {
    for (let i = 0; i < args.shots.length; i++) {
      const shot = args.shots[i];
      const result = await generateGrokClip({
        prompt: composeShotPrompt(args.continuity, shot.prompt),
        durationSeconds: shot.durationSeconds,
        aspectRatio: args.aspectRatio as "16:9" | "9:16" | "1:1",
        resolution: args.resolution,
        model: args.model,
        firstFrameUrl: previousFrame,
        referenceImageUrls: characterRefs.length > 0 ? Array.from(new Set(characterRefs)) : undefined,
      }, { waitForCompletion: true, timeoutSeconds: args.timeoutSecondsPerShot });

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
      };
      job.spentUsd += result.costUsd ?? 0;
      job.shots.push(entry);

      if (result.status !== "completed" || !result.videoUrl) {
        job.state = "stopped";
        job.error = `Shot ${shotNumber} failed: ${result.error ?? "no video URL returned"}. The chain stopped so no later shot renders without continuity.`;
        job.finishedAt = Date.now();
        return;
      }

      const clipPath = await resolveToLocalFile(result.videoUrl);
      entry.localPath = clipPath;
      const frame = await extractLastFrame({ file: clipPath });
      if (!frame.path) {
        job.state = "stopped";
        job.error = `Shot ${shotNumber} rendered but its last frame could not be extracted, so the chain has no anchor for the next shot.`;
        job.finishedAt = Date.now();
        return;
      }
      previousFrame = frame.path;
      entry.framePath = frame.path;
      job.lastFramePath = frame.path;
      job.completed = shotNumber;
    }

    if (args.assemble) {
      const files = job.shots
        .map((shot) => shot.localPath)
        .filter((p): p is string => Boolean(p))
        .map((file) => ({ file: file as string, trimStart: undefined, trimEnd: undefined }));
      const assembled = await assembleClips({ clips: files, fadeDuration: args.fadeDuration });
      job.filmPath = assembled.path;
      job.fileUrl = `file://${assembled.path}`;
      job.filmDurationSeconds = await probeDuration(assembled.path);
      job.filmBytes = (await (await import("node:fs/promises")).stat(assembled.path)).size;
    }

    job.state = "completed";
    job.finishedAt = Date.now();
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
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
                "No job has that id in this process. Jobs do not survive a server restart, so a " +
                "film can only be continued within the same session that rendered it.",
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

    // Measured on real renders, 8 seconds each: 480p billed 0.64, 720p billed
    // 1.12, 1080p billed 2.00. The old flat 8 cents per second was only ever the
    // 480p rate, which is also the soft 848x480 default, so every earlier estimate
    // was quietly quoting the cheapest and worst-looking setting.
    const estimate = Math.round(
      args.shots.reduce((sum, s) => sum + s.durationSeconds * ratePerSecond(args.resolution), 0) * 100,
    ) / 100;

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
              continuity: "Each shot starts from the previous shot's last frame.",
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
      ...(resumeJob ? {
        resumedFrom: { jobId: resumeJob.id, fromShot: carried.length },
        carriedOverUsd: Math.round(carried.reduce((sum, s) => sum + (s.costUsd ?? 0), 0) * 100) / 100,
      } : {}),
    };
    sequenceJobs.set(job.id, job);

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
    const job = sequenceJobs.get(args.jobId);
    if (!job) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Unknown jobId",
            detail: "No sequence job has that id in this process. Jobs do not survive a server restart.",
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

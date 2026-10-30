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
  referenceImageUrls: z.array(z.string().url()).optional(),
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

function planShots(opts: {
  sceneDescription: string;
  characterNames: string[];
  shotCount: number;
  totalDurationSeconds: number;
}) {
  const { sceneDescription, characterNames, shotCount, totalDurationSeconds } = opts;
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
      referenceImageUrls: z.array(z.string()).optional(),
      firstFrameUrl: z
        .string()
        .optional()
        .describe(
          "Image to pin as the first frame: public https URL, data URI, or a local path from " +
          "extract_last_frame. This is what carries continuity across a cut.",
        ),
      durationSeconds: z.number().min(1).max(15).default(8),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      model: z.string().default("grok-imagine-video-1.5"),
      waitForCompletion: z.boolean().default(true),
      timeoutSeconds: z.number().min(10).max(600).default(240),
    }),
  },
  async (args) => {
    const { waitForCompletion, timeoutSeconds, ...job } = args;
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
      "Assemble ordered clips into a single film with cross-fades, using real FFmpeg. " +
      "Accepts public https URLs, file:// paths, or local paths from earlier tool calls. " +
      "Falls back to hard cuts when the available FFmpeg has no xfade filter.",
    inputSchema: z.object({
      clips: z.array(z.object({
        url: z.string(),
        title: z.string().optional(),
        trimStart: z.number().min(0).optional(),
        trimEnd: z.number().min(0).optional(),
      })).min(1),
      fadeDuration: z.number().min(0).max(5).default(0.5),
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
          : "Film assembled with hard cuts: this FFmpeg build has no xfade filter. Install FFmpeg 4.3+ for cross-fades.",
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

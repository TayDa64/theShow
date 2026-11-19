/**
 * Real media operations for the theShow pipeline:
 *   - extracting the last frame of a clip (the continuity bridge image)
 *   - trimming and joining ordered clips into a single film
 *
 * The system FFmpeg is used when it has `xfade`. The 2018 installer is the
 * last resort. Chain and cut joins do not need `xfade`. A crossfade on a
 * binary without it is emulated and reported. It is never dropped silently.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assemblePlanned, assertBedCoversFilm, extractExactLastFrame } from "../src/lib/assembleShared";
import { correlateGrayBuffers } from "../src/lib/frameMatch";
import {
  hasAudioStream,
  probeDuration,
  resolveTools,
} from "../src/lib/ffmpegResolve";
import type { JoinRequest, PlannedJoin, TrimEndSource } from "../src/lib/joinPlan";

const exec = promisify(execFile);

export { assertBedCoversFilm, correlateGrayBuffers, hasAudioStream, probeDuration, resolveTools };

/**
 * Where generated frames and films land.
 *
 * A stable per-user directory rather than a temp path, because these are the
 * user's films: a tmpdir is cleared by a reboot or a cleaner, and losing a paid
 * render to housekeeping is unforgivable. THESHOW_OUTPUT_DIR still overrides.
 */
export const OUTPUT_DIR =
  process.env.THESHOW_OUTPUT_DIR || join(homedir(), ".theshow", "media");

/** Where film jobs are kept so a film survives a server restart. */
export const JOBS_DIR =
  process.env.THESHOW_JOBS_DIR || join(homedir(), ".theshow", "jobs");

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

/**
 * Pull the final frame of a clip as a PNG. This is the image a next shot uses
 * as `firstFrameUrl`, which is what actually carries continuity across a cut.
 */
/**
 * The first frame of a clip, named from the file path so a second call reuses it.
 * This is a local ffmpeg read. It does not call a paid API.
 */
export async function extractFirstFrame(file: string, destDir?: string): Promise<string | undefined> {
  const { ffmpeg } = await resolveTools();
  const dir = destDir ?? await ensureOutputDir();
  if (destDir) await mkdir(destDir, { recursive: true });
  const digest = createHash("sha1").update(`first:${file}`).digest("hex").slice(0, 16);
  const outPath = join(dir, `frame-first-${digest}.png`);
  try {
    const existing = await stat(outPath);
    if (existing.size > 0) return outPath;
  } catch {
    // Not extracted yet.
  }
  try {
    await exec(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", file, "-vframes", "1", "-q:v", "2", outPath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    const info = await stat(outPath);
    if (info.size > 0) return outPath;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function extractLastFrame(input: {
  file: string;
  /** Ignored. The true last frame is decoded with `-update 1`. */
  seekBackSeconds?: number;
}) {
  const { ffmpeg } = await resolveTools();
  const dir = await ensureOutputDir();
  const digest = createHash("sha1").update(`${input.file}:${Date.now()}`).digest("hex").slice(0, 12);
  const outPath = join(dir, `frame-${digest}.png`);
  const frame = await extractExactLastFrame({ file: input.file, dest: outPath });
  const info = await stat(outPath);
  return {
    path: frame.path,
    bytes: info.size,
    ffmpeg,
    frameIndex: frame.frameIndex,
    framePts: frame.framePts,
  };
}

/**
 * How close a clip's true last frame is to the picture it was pinned to land on.
 *
 * A pinned closing frame can be accepted and then quietly ignored: the render
 * comes back `completed`, is billed in full, and ends somewhere else entirely.
 * Measured on a real four-shot film, three shots closed on their board frame at
 * 0.97, 0.93 and - refused outright - while the fourth returned 0.13. Nothing
 * in the poll response says which happened, so it has to be measured from the
 * pixels after the fact.
 *
 * Compares 32x32 grayscale thumbnails. On that film the scores were 0.994,
 * 0.179 and 0.981 against a 0.6 line, which is as wide a margin as this needs.
 */
export async function closingFrameAgreement(input: {
  clip: string;
  frame: string;
}): Promise<number | undefined> {
  const { ffmpeg } = await resolveTools();
  const thumb = async (args: string[]) => {
    const { stdout } = await exec(ffmpeg, args, { encoding: "buffer", maxBuffer: 4 << 20 });
    const buf = stdout as unknown as Buffer;
    return buf.subarray(0, 32 * 32);
  };
  try {
    const a = await thumb([
      "-v", "error", "-sseof", "-0.12", "-i", input.clip,
      "-update", "1", "-frames:v", "1",
      "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-",
    ]);
    const b = await thumb(["-v", "error", "-i", input.frame, "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-"]);
    if (a.length < 1024 || b.length < 1024) return undefined;
    let ma = 0, mb = 0;
    for (let i = 0; i < 1024; i++) { ma += a[i]; mb += b[i]; }
    ma /= 1024; mb /= 1024;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 1024; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    if (da === 0 || db === 0) return undefined;
    return Math.round((num / Math.sqrt(da * db)) * 1000) / 1000;
  } catch {
    // A measurement that cannot be taken must not fail a film that rendered.
    return undefined;
  }
}

/**
 * 32×32 grayscale correlation of two still images on disk.
 * The same measurement as closingFrameAgreement, without seeking a clip tail.
 * It is not a face match and it does not call a vision API.
 */
export async function grayscaleStillCorrelation(left: string, right: string): Promise<number | undefined> {
  const { ffmpeg } = await resolveTools();
  const thumb = async (file: string) => {
    const { stdout } = await exec(ffmpeg, [
      "-v", "error", "-i", file,
      "-frames:v", "1",
      "-vf", "scale=32:32,format=gray",
      "-f", "rawvideo", "-",
    ], { encoding: "buffer", maxBuffer: 4 << 20 });
    const buf = stdout as unknown as Buffer;
    return buf.subarray(0, 32 * 32);
  };
  try {
    const a = await thumb(left);
    const b = await thumb(right);
    return correlateGrayBuffers(a, b);
  } catch {
    return undefined;
  }
}

/** Below this, a clip did not arrive on the frame it was pinned to. */
export const CLOSING_FRAME_MATCH_THRESHOLD = 0.6;

export type AssembleClip = {
  file: string;
  trimStart?: number;
  trimEnd?: number;
  trimEndSource?: TrimEndSource;
  /** Join from the previous clip. Omitted means auto (local chain detection). */
  join?: JoinRequest;
  /** Chain frame inside this clip, used by the join into the next clip. */
  chainFrameIndex?: number;
  chainedFromPrevious?: boolean;
  boardMatch?: boolean;
};

/**
 * Assemble ordered clips into one film.
 *
 * A fade of 0 is a real hard cut. It is not an xfade with duration 0: FFmpeg's
 * xfade treats a zero-length transition as "the second input starts where the
 * first ends", and chained, that silently collapses the output to the first
 * clip. A three-shot film asked for a hard cut came back 2.04s long with one
 * shot in it. So the two cases take genuinely different paths: `concat` for
 * hard cuts, `xfade` only when there is an actual overlap to blend.
 *
 * Both paths normalise every input onto the first clip's geometry, because
 * chained generations come back at slightly different sizes (848x480 then
 * 736x416) and neither filter accepts mismatched streams.
 */
/**
 * A short bed used to be looped and padded with silence, which is how a drone
 * stopped before the first line. A bed that does not cover the film is refused.
 * The check itself lives in the shared assembler.
 */

/** Per-clip audio taps. mute and replace never read [i:a]. Audio is padded or trimmed to the video duration. */
export function planClipAudioFilters(input: {
  durations: number[];
  clipHasAudio: boolean[];
  clipAudio?: "keep" | "mute" | "replace";
}): string[] {
  const mode = input.clipAudio ?? "keep";
  return input.durations.map((duration, index) => {
    const useClip = mode === "keep" && Boolean(input.clipHasAudio[index]);
    const length = Number.isFinite(duration) && duration > 0 ? duration : 0.1;
    if (useClip) {
      return `[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:${length},apad=whole_dur=${length},asetpts=PTS-STARTPTS[a${index}]`;
    }
    return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${length},apad=whole_dur=${length},asetpts=PTS-STARTPTS[a${index}]`;
  });
}

export async function assembleClips(input: {
  clips: AssembleClip[];
  fadeDuration: number;
  /**
   * Optional music, narration, or ambience laid under the whole film. It is
   * refused if shorter than the film, trimmed to the film, faded out at the end, and mixed under
   * the clips' own audio rather than replacing it.
   */
  audioTrackFile?: string;
  /**
   * Bed level as a linear gain. 0.25 is a bed you can talk over; 1.0 is loud.
   * 0 omits the bed.
   */
  audioTrackVolume?: number;
  /** Seconds of fade at the end of the bed, so a film never ends on a cut-off note. */
  audioTrackFadeOutSeconds?: number;
  /**
   * keep mixes each clip's own audio. mute drops it and keeps the bed or silence.
   * replace drops it so the bed is the soundtrack.
   */
  clipAudio?: "keep" | "mute" | "replace";
  outputSize?: { width: number; height: number } | null;
}): Promise<{
  path: string;
  mode: "single" | "concat" | "xfade" | "emulated";
  hasXfade: boolean;
  fadeSeconds: number;
  audioBed: boolean;
  durationSeconds: number;
  joins: PlannedJoin[];
  outputFps: number;
  totalFrames: number;
  filterGraph: string;
  notice?: string;
}> {
  const dir = await ensureOutputDir();
  const digest = createHash("sha1")
    .update(input.clips.map((clip) => `${clip.file}:${clip.trimStart ?? ""}:${clip.trimEnd ?? ""}:${clip.join ?? ""}:${clip.chainFrameIndex ?? ""}`).join("|") + Date.now())
    .digest("hex")
    .slice(0, 12);
  const outPath = join(dir, `film-${digest}.mp4`);
  const assembled = await assemblePlanned({
    clips: input.clips,
    crossfadeSeconds: input.fadeDuration,
    outputPath: outPath,
    outputSize: input.outputSize,
    audioTrackFile: input.audioTrackFile,
    audioTrackVolume: input.audioTrackVolume,
    audioTrackFadeOutSeconds: input.audioTrackFadeOutSeconds,
    clipAudio: input.clipAudio,
  });
  return {
    path: assembled.path,
    mode: assembled.mode,
    hasXfade: assembled.hasXfade,
    fadeSeconds: assembled.fadeSeconds,
    audioBed: assembled.audioBed,
    durationSeconds: assembled.durationSeconds,
    joins: assembled.joins,
    outputFps: assembled.outputFps,
    totalFrames: assembled.totalFrames,
    filterGraph: assembled.filterGraph,
    ...(assembled.notice ? { notice: assembled.notice } : {}),
  };
}

export async function pathToDataUrl(file: string, mime = "image/png") {
  const buffer = await readFile(file);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

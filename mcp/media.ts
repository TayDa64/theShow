/**
 * Real media operations for the theShow pipeline:
 *   - extracting the last frame of a clip (the continuity bridge image)
 *   - trimming and cross-fading ordered clips into a single film
 *
 * Uses the system FFmpeg when it is new enough to have `xfade` (a 2018-era
 * bundled build does not), and falls back to a hard-cut concat so assembly
 * still succeeds on older binaries.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

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

type ToolPaths = { ffmpeg: string; ffprobe: string; hasXfade: boolean };

let toolCache: Promise<ToolPaths> | undefined;

async function binaryVersion(bin: string) {
  try {
    const { stdout, stderr } = await exec(bin, ["-hide_banner", "-version"]);
    return `${stdout}${stderr}`;
  } catch {
    return undefined;
  }
}

async function hasFilter(ffmpeg: string, filter: string) {
  try {
    const { stdout } = await exec(ffmpeg, ["-hide_banner", "-filters"]);
    return stdout.split("\n").some((line) => line.includes(` ${filter} `));
  } catch {
    return false;
  }
}

/**
 * Pick the best available FFmpeg. A newer system binary beats the pinned
 * `@ffmpeg-installer` one, which is a 2018 build lacking `xfade`.
 */
export function resolveTools(): Promise<ToolPaths> {
  toolCache ??= (async () => {
    const candidates: string[] = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    candidates.push("/usr/bin/ffmpeg", "ffmpeg");
    try {
      const installer = await import("@ffmpeg-installer/ffmpeg");
      const p = (installer.default ?? installer).path;
      if (p) candidates.push(p);
    } catch {
      // installer package absent; system binaries already queued
    }

    for (const candidate of candidates) {
      const version = await binaryVersion(candidate);
      if (!version) continue;
      const ffprobe = process.env.FFPROBE_PATH || (candidate === "ffmpeg" ? "ffprobe" : candidate.replace(/ffmpeg$/, "ffprobe"));
      return { ffmpeg: candidate, ffprobe, hasXfade: await hasFilter(candidate, "xfade") };
    }
    throw new Error("No working FFmpeg binary found. Set FFMPEG_PATH.");
  })();
  return toolCache;
}

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

export async function probeDuration(file: string): Promise<number | undefined> {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

async function probeVideoGeometry(file: string) {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "default=nw=1",
      file,
    ]);
    const width = Number.parseInt(stdout.match(/width=(\d+)/)?.[1] ?? "", 10);
    const height = Number.parseInt(stdout.match(/height=(\d+)/)?.[1] ?? "", 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

async function hasAudioStream(file: string) {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "default=nw=1",
      file,
    ]);
    return stdout.includes("codec_type=audio");
  } catch {
    return false;
  }
}

/**
 * Pull the final frame of a clip as a PNG. This is the image a next shot uses
 * as `firstFrameUrl`, which is what actually carries continuity across a cut.
 */
export async function extractLastFrame(input: {
  file: string;
  /** How far back from the end to seek. Kept small so we get the true last frame. */
  seekBackSeconds?: number;
}) {
  const { ffmpeg } = await resolveTools();
  const dir = await ensureOutputDir();
  const digest = createHash("sha1").update(`${input.file}:${Date.now()}`).digest("hex").slice(0, 12);
  const outPath = join(dir, `frame-${digest}.png`);

  const seek = input.seekBackSeconds ?? 0.15;
  // A cheap seek to the end can land past the final frame on a short clip, so
  // the fallback decodes the whole thing and keeps the last frame. The fallback
  // used to select `n\,0` - the FIRST frame - which meant a clip whose tail
  // would not seek handed the next shot the wrong end to chain from, and the
  // seam looked like model drift instead of a bug here.
  const attempts: string[][] = [
    // Preferred: seek near the end, decode one frame.
    ["-y", "-hide_banner", "-loglevel", "error", "-sseof", `-${seek}`, "-i", input.file, "-vframes", "1", "-q:v", "2", outPath],
    // Fallback: decode from the start and keep the genuinely last frame.
    ["-y", "-hide_banner", "-loglevel", "error", "-i", input.file, "-update", "1", "-vf", "reverse", "-vframes", "1", outPath],
  ];

  let lastError: unknown;
  for (const args of attempts) {
    try {
      await exec(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
      const info = await stat(outPath);
      if (info.size > 0) {
        return { path: outPath, bytes: info.size, ffmpeg };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not extract a frame from ${input.file}: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
  );
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

/** Below this, a clip did not arrive on the frame it was pinned to. */
export const CLOSING_FRAME_MATCH_THRESHOLD = 0.6;

export type AssembleClip = {
  file: string;
  trimStart?: number;
  trimEnd?: number;
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
export async function assembleClips(input: {
  clips: AssembleClip[];
  fadeDuration: number;
  /**
   * Optional music, narration, or ambience laid under the whole film. It is
   * looped if short, trimmed to the film, faded out at the end, and mixed under
   * the clips' own audio rather than replacing it.
   */
  audioTrackFile?: string;
  /** Bed level as a linear gain. 0.25 is a bed you can talk over; 1.0 is loud. */
  audioTrackVolume?: number;
  /** Seconds of fade at the end of the bed, so a film never ends on a cut-off note. */
  audioTrackFadeOutSeconds?: number;
}) {
  const { ffmpeg, hasXfade } = await resolveTools();
  const dir = await ensureOutputDir();
  const digest = createHash("sha1")
    .update(input.clips.map((c) => `${c.file}:${c.trimStart ?? ""}:${c.trimEnd ?? ""}`).join("|") + Date.now())
    .digest("hex")
    .slice(0, 12);
  const outPath = join(dir, `film-${digest}.mp4`);

  if (input.clips.length === 0) throw new Error("No clips to assemble.");
  if (input.clips.length === 1) {
    // Fast path: normalize the single clip into an mp4 container.
    await exec(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input.clips[0].file,
      "-c", "copy", outPath,
    ], { maxBuffer: 32 * 1024 * 1024 });
    return { path: outPath, mode: "single" as const, hasXfade };
  }

  // Probe every clip once: trim points and cross-fade offsets both need real
  // durations, and the concat path needs them for its silent audio beds.
  const durations: number[] = [];
  for (const clip of input.clips) {
    const full = await probeDuration(clip.file);
    if (full === undefined) throw new Error(`Could not read duration of ${clip.file}`);
    const start = clip.trimStart ?? 0;
    const end = clip.trimEnd ?? full;
    durations.push(Math.max(0.1, end - start));
  }

  const wantsFade = input.fadeDuration > 0;
  // Clamp the fade so it can never eat more than half of the shortest clip.
  const fade = wantsFade
    ? Math.min(input.fadeDuration, Math.min(...durations) / 2)
    : 0;

  if (!wantsFade && !hasXfade) {
    // No xfade and no fade wanted: a stream-copy concat is exact and instant.
    // Only safe when every clip already shares codec and geometry, so it falls
    // through to the filter path below on any mismatch.
    const listPath = join(dir, `concat-${digest}.txt`);
    const lines = input.clips.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'`);
    await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
    const copyOut = join(dir, `film-copy-${digest}.mp4`);
    try {
      await exec(ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", copyOut,
      ], { maxBuffer: 32 * 1024 * 1024 });
      const copied = await probeDuration(copyOut);
      if (copied !== undefined) {
        return { path: copyOut, mode: "concat" as const, hasXfade };
      }
    } catch {
      // Mismatched streams: fall through to the normalising filter path.
    }
  }

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (let i = 0; i < input.clips.length; i++) {
    const clip = input.clips[i];
    const start = clip.trimStart ?? 0;
    const end = clip.trimEnd ?? durations[i] + start;
    args.push("-ss", String(start), "-to", String(end), "-i", clip.file);
  }

  // Both xfade and concat require every input to share a constant frame rate
  // and identical dimensions, so normalise all streams onto the first clip.
  const geometry = await probeVideoGeometry(input.clips[0].file);
  const width = geometry?.width ?? 1280;
  const height = geometry?.height ?? 720;
  const fps = 24;

  const withAudio = await Promise.all(input.clips.map((clip) => hasAudioStream(clip.file)));

  const filters: string[] = [];
  const n = input.clips.length;
  for (let i = 0; i < n; i++) {
    filters.push(
      `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`,
    );
    if (withAudio[i]) {
      filters.push(`[${i}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
    } else {
      // Silent bed so every input contributes an audio track either way.
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${durations[i]},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
  }

  let mode: "concat" | "xfade";
  // Needed for the bed: it has to be trimmed to exactly the film's length.
  let totalDuration = durations.reduce((sum, d) => sum + d, 0);

  if (fade === 0) {
    // Hard cuts. concat joins the streams end to end with no overlap, which is
    // exactly what a cut is; xfade would blend two frames that should never
    // both be on screen.
    const videoInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
    const audioInputs = Array.from({ length: n }, (_, i) => `[a${i}]`).join("");
    filters.push(`${videoInputs}concat=n=${n}:v=1:a=0[vout]`);
    filters.push(`${audioInputs}concat=n=${n}:v=0:a=1[aout]`);
    mode = "concat";
  } else {
    let previousV = "v0";
    let previousA = "a0";
    let elapsed = durations[0];
    for (let i = 1; i < n; i++) {
      const offset = Math.max(0, elapsed - fade);
      const isLast = i === n - 1;
      const vLabel = isLast ? "vout" : `vx${i}`;
      const aLabel = isLast ? "aout" : `ax${i}`;
      filters.push(`[${previousV}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[${vLabel}]`);
      filters.push(`[${previousA}][a${i}]acrossfade=d=${fade}:c1=tri:c2=tri[${aLabel}]`);
      previousV = vLabel;
      previousA = aLabel;
      elapsed = offset + durations[i];
    }
    totalDuration = elapsed;
    mode = "xfade";
  }

  // Music or narration bed, if one was supplied. Added as an extra input after
  // the clips so its index is the clip count, and looped so a 30-second track
  // can sit under a three-minute film.
  let audioMap = "[aout]";
  if (input.audioTrackFile) {
    const bedIndex = input.clips.length;
    const gain = Math.min(Math.max(input.audioTrackVolume ?? 0.25, 0.01), 4);
    const fadeOut = Math.min(
      input.audioTrackFadeOutSeconds ?? 1.5,
      Math.max(totalDuration / 2, 0.1),
    );
    args.push("-stream_loop", "-1", "-i", input.audioTrackFile);
    filters.push(
      `[${bedIndex}:a]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `volume=${gain.toFixed(3)},` +
      `afade=t=out:st=${Math.max(totalDuration - fadeOut, 0).toFixed(3)}:d=${fadeOut.toFixed(3)}[bed]`,
    );
    // duration=first keeps the film's own length and lets the music stop with it.
    filters.push("[aout][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aoutmix]");
    audioMap = "[aoutmix]";
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", audioMap,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  );

  await exec(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
  return mode === "xfade"
    ? { path: outPath, mode, hasXfade, fadeSeconds: fade, audioBed: Boolean(input.audioTrackFile), durationSeconds: totalDuration }
    : { path: outPath, mode, hasXfade, fadeSeconds: 0, audioBed: Boolean(input.audioTrackFile), durationSeconds: totalDuration };
}

export async function pathToDataUrl(file: string, mime = "image/png") {
  const buffer = await readFile(file);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

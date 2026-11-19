/**
 * Shared ffmpeg/ffprobe lookup. System binaries with xfade win. The pinned
 * 2018 installer is the last resort. No HTTP imports.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ToolPaths = { ffmpeg: string; ffprobe: string; hasXfade: boolean };

let toolCache: { key: string; value: Promise<ToolPaths> } | undefined;

function cacheKey(): string {
  return `${process.env.FFMPEG_PATH ?? ''}|${process.env.FFPROBE_PATH ?? ''}`;
}

async function binaryVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(bin, ['-hide_banner', '-version']);
    return `${stdout}${stderr}`;
  } catch {
    return undefined;
  }
}

async function hasFilter(ffmpeg: string, filter: string): Promise<boolean> {
  try {
    const { stdout } = await exec(ffmpeg, ['-hide_banner', '-filters']);
    return stdout.split('\n').some((line) => line.includes(` ${filter} `));
  } catch {
    return false;
  }
}

export function resetToolCache(): void {
  toolCache = undefined;
}

/** Pick the best available FFmpeg. A newer system binary beats the 2018 installer. */
export function resolveTools(): Promise<ToolPaths> {
  const key = cacheKey();
  if (!toolCache || toolCache.key !== key) {
    toolCache = {
      key,
      value: (async () => {
        const candidates: string[] = [];
        if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
        candidates.push('/usr/bin/ffmpeg', 'ffmpeg');
        try {
          const installer = await import('@ffmpeg-installer/ffmpeg');
          const resolved = (installer.default ?? installer) as { path?: string };
          if (resolved.path) candidates.push(resolved.path);
        } catch {
          // The installer package is optional. System binaries are already queued.
        }
        for (const candidate of candidates) {
          const version = await binaryVersion(candidate);
          if (!version) continue;
          const ffprobe = process.env.FFPROBE_PATH
            || (candidate === 'ffmpeg' ? 'ffprobe' : candidate.replace(/ffmpeg$/, 'ffprobe'));
          return { ffmpeg: candidate, ffprobe, hasXfade: await hasFilter(candidate, 'xfade') };
        }
        throw new Error('No working FFmpeg binary found. Set FFMPEG_PATH.');
      })(),
    };
  }
  return toolCache.value;
}

export async function runFfmpeg(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<void> {
  const { ffmpeg } = await resolveTools();
  try {
    await exec(ffmpeg, args, { maxBuffer });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
    const message = error instanceof Error ? error.message : String(error);
    const detail = `${message}\n${stderr}`.trim();
    throw new Error(detail);
  }
}

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  duration: number;
  sar: string;
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/');
  const numerator = Number(num);
  const denominator = Number(den ?? 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const { ffprobe } = await resolveTools();
  const { stdout } = await exec(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,sample_aspect_ratio',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, string>> };
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`Could not read video geometry of ${file}`);
  const fps = parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate);
  const width = Number.parseInt(stream.width ?? '', 10);
  const height = Number.parseInt(stream.height ?? '', 10);
  let frameCount = Number.parseInt(stream.nb_frames ?? '', 10);
  if (!Number.isFinite(frameCount) || frameCount <= 0) {
    const counted = await exec(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-count_frames',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    frameCount = Number.parseInt(counted.stdout.trim(), 10);
  }
  const duration = Number.parseFloat(stream.duration ?? '');
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(fps > 0) || !(frameCount > 0)) {
    throw new Error(`Could not read frame geometry of ${file}`);
  }
  return {
    width,
    height,
    fps,
    frameCount,
    duration: Number.isFinite(duration) && duration > 0 ? duration : frameCount / fps,
    sar: stream.sample_aspect_ratio || '1:1',
  };
}

export async function probeDuration(file: string): Promise<number | undefined> {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export async function probeAudioDuration(file: string): Promise<number | undefined> {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const { ffprobe } = await resolveTools();
  try {
    const { stdout } = await exec(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1',
      file,
    ]);
    return stdout.includes('audio');
  } catch {
    return false;
  }
}

export async function readGrayFrame(file: string, frameIndex: number): Promise<Buffer> {
  const { ffmpeg } = await resolveTools();
  const { stdout } = await exec(ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-map', '0:v:0',
    '-an',
    '-vf', `select=eq(n\\,${frameIndex}),scale=32:32,format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-',
  ], { encoding: 'buffer', maxBuffer: 4 << 20 });
  return (stdout as unknown as Buffer).subarray(0, 32 * 32);
}

export async function readGrayTail(file: string, frameCount: number, tail: number): Promise<Buffer[]> {
  const { ffmpeg } = await resolveTools();
  const start = Math.max(frameCount - tail, 0);
  const { stdout } = await exec(ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-map', '0:v:0',
    '-an',
    '-vf', `select=gte(n\\,${start}),setpts=PTS-STARTPTS,scale=32:32,format=gray`,
    '-frames:v', String(Math.min(tail, frameCount)),
    '-f', 'rawvideo',
    '-',
  ], { encoding: 'buffer', maxBuffer: 8 << 20 });
  const buffer = stdout as unknown as Buffer;
  const frames: Buffer[] = [];
  const count = Math.min(tail, frameCount);
  for (let index = 0; index < count; index += 1) {
    const slice = buffer.subarray(index * 1024, (index + 1) * 1024);
    if (slice.length < 1024) break;
    frames.push(slice);
  }
  return frames;
}

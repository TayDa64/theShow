/**
 * One ffmpeg pass for a film. Studio and MCP both call this.
 * Join decisions come from the pure planner. The binary comes from the shared resolver.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { detectChainFrame } from './detectChain';
import { buildJoinFilterGraph, type GraphClip } from './joinGraph';
import {
  assemblyMode,
  assemblyNotice,
  exclusiveFrameAt,
  frameIndexAtOrAfter,
  planJoins,
  chooseOutputFps,
  chooseOutputSize,
  type ClipJoinInput,
  type JoinPlan,
  type JoinRequest,
  type PlannedJoin,
  type TrimEndSource,
} from './joinPlan';
import {
  hasAudioStream,
  probeAudioDuration,
  probeDuration,
  probeVideo,
  resolveTools,
  runFfmpeg,
  type VideoProbe,
} from './ffmpegResolve';

export interface AssembleSourceClip {
  file: string;
  trimStart?: number;
  trimEnd?: number;
  trimEndSource?: TrimEndSource;
  join?: JoinRequest;
  /** Chain frame inside this clip, used by the join into the next clip. */
  chainFrameIndex?: number;
  chainedFromPrevious?: boolean;
  boardMatch?: boolean;
}

export interface AssembleRequest {
  clips: AssembleSourceClip[];
  crossfadeSeconds: number;
  outputPath: string;
  outputSize?: { width: number; height: number } | null;
  audioTrackFile?: string;
  audioTrackVolume?: number;
  audioTrackFadeOutSeconds?: number;
  clipAudio?: 'keep' | 'mute' | 'replace';
}

export interface AssembleResult {
  path: string;
  mode: 'single' | 'concat' | 'xfade' | 'emulated';
  hasXfade: boolean;
  fadeSeconds: number;
  joins: PlannedJoin[];
  totalFrames: number;
  outputFps: number;
  durationSeconds: number;
  filterGraph: string;
  notice?: string;
  audioBed: boolean;
  width: number;
  height: number;
}

export function assertBedCoversFilm(bedSeconds: number | undefined, filmSeconds: number): void {
  if (bedSeconds === undefined || bedSeconds + 0.05 < filmSeconds) {
    throw new Error(
      'Audio bed is shorter than the film, so it was refused instead of being padded or looped.',
    );
  }
}

function needsDetection(clip: AssembleSourceClip, previous?: AssembleSourceClip): boolean {
  if (!previous) return false;
  if (Number.isInteger(previous.chainFrameIndex)) return false;
  const requested = clip.join ?? 'auto';
  if (requested === 'cut' || requested === 'crossfade') return false;
  return true;
}

export async function planAssembly(request: AssembleRequest): Promise<{
  plan: JoinPlan;
  probes: VideoProbe[];
  hasAudio: boolean[];
  hasXfade: boolean;
}> {
  const { hasXfade } = await resolveTools();
  const probes: VideoProbe[] = [];
  const audioFlags: boolean[] = [];
  for (const clip of request.clips) {
    probes.push(await probeVideo(clip.file));
    audioFlags.push(await hasAudioStream(clip.file));
  }
  const detected: Array<number | undefined> = request.clips.map(() => undefined);
  for (let index = 1; index < request.clips.length; index += 1) {
    const clip = request.clips[index];
    const previous = request.clips[index - 1];
    if (!needsDetection(clip, previous)) continue;
    const match = await detectChainFrame({
      outgoingFile: previous.file,
      incomingFile: clip.file,
      outgoingFrameCount: probes[index - 1].frameCount,
    });
    if (match) detected[index] = match.index;
  }
  const outputFps = chooseOutputFps(probes.map((probe) => probe.fps));
  const inputs: ClipJoinInput[] = request.clips.map((clip, index) => {
    const probe = probes[index];
    const trimStartFrame = clip.trimStart !== undefined
      ? frameIndexAtOrAfter(clip.trimStart, probe.fps)
      : 0;
    const trimEndFrame = clip.trimEnd !== undefined
      ? exclusiveFrameAt(clip.trimEnd, probe.fps)
      : probe.frameCount;
    return {
      frameCount: probe.frameCount,
      fps: probe.fps,
      trimStartFrame,
      trimEndFrame: Math.min(Math.max(trimEndFrame, trimStartFrame + 1), probe.frameCount),
      trimEndSource: clip.trimEndSource,
      join: clip.join,
      chainFrameIndex: clip.chainFrameIndex,
      detectedChainFrame: detected[index],
      chainedFromPrevious: clip.chainedFromPrevious,
      boardMatch: clip.boardMatch,
    };
  });
  const plan = planJoins({
    clips: inputs,
    crossfadeSeconds: request.crossfadeSeconds,
    outputFps,
    xfadeAvailable: hasXfade,
  });
  return { plan, probes, hasAudio: audioFlags, hasXfade };
}

export async function assemblePlanned(request: AssembleRequest): Promise<AssembleResult> {
  if (request.clips.length < 1) throw new Error('No clips to assemble.');
  const { plan, probes, hasAudio, hasXfade } = await planAssembly(request);
  const size = chooseOutputSize({
    project: request.outputSize,
    first: probes[0],
  });
  const clipAudio = request.clipAudio ?? 'keep';
  const graphClips: GraphClip[] = plan.segments.map((segment, index) => ({
    inputIndex: index,
    hasAudio: clipAudio === 'keep' && hasAudio[index],
    sourceFps: probes[index].fps,
    startFrame: segment.startFrame,
    endFrame: segment.endFrame,
    outputFrames: segment.frameCount,
  }));
  const graph = buildJoinFilterGraph({
    plan,
    clips: graphClips,
    outputWidth: size.width,
    outputHeight: size.height,
    xfadeAvailable: hasXfade,
  });
  const durationSeconds = plan.totalFrames / plan.outputFps;
  const filters = graph.filterComplex.split(';').filter(Boolean);
  let audioMap = `[${graph.audioLabel}]`;
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  request.clips.forEach((clip) => {
    args.push('-i', clip.file);
  });
  const bedGain = request.audioTrackVolume ?? 0.25;
  const wantBed = Boolean(request.audioTrackFile) && bedGain > 0;
  if (wantBed && request.audioTrackFile) {
    const bedSeconds = await probeDuration(request.audioTrackFile);
    assertBedCoversFilm(bedSeconds, durationSeconds);
    const bedIndex = request.clips.length;
    const gain = Math.min(Math.max(bedGain, 0), 4);
    const fadeOut = Math.min(request.audioTrackFadeOutSeconds ?? 1.5, Math.max(durationSeconds / 2, 0.1));
    args.push('-i', request.audioTrackFile);
    const bedFilter =
      `[${bedIndex}:a]atrim=0:${durationSeconds.toFixed(6)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `volume=${gain.toFixed(3)},` +
      `afade=t=out:st=${Math.max(durationSeconds - fadeOut, 0).toFixed(6)}:d=${fadeOut.toFixed(6)}`;
    if (clipAudio === 'replace') {
      filters.push(`${bedFilter}[aoutmix]`);
    } else {
      filters.push(`${bedFilter}[bed]`);
      filters.push(`[${graph.audioLabel}][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aoutmix]`);
    }
    audioMap = '[aoutmix]';
  }
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${graph.videoLabel}]`,
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(plan.outputFps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    request.outputPath,
  );
  await mkdir(dirname(request.outputPath), { recursive: true });
  await runFfmpeg(args);
  const notice = assemblyNotice(plan.joins);
  const fadeSeconds = plan.joins.some((join) => join.applied === 'crossfade' || join.applied === 'emulated')
    ? request.crossfadeSeconds
    : 0;
  return {
    path: request.outputPath,
    mode: assemblyMode(plan),
    hasXfade,
    fadeSeconds,
    joins: plan.joins,
    totalFrames: plan.totalFrames,
    outputFps: plan.outputFps,
    durationSeconds,
    filterGraph: filters.join(';'),
    ...(notice ? { notice } : {}),
    audioBed: wantBed,
    width: size.width,
    height: size.height,
  };
}

export async function extractExactLastFrame(input: { file: string; dest: string }): Promise<{
  path: string;
  frameIndex: number;
  framePts: number;
  fps: number;
}> {
  const probe = await probeVideo(input.file);
  const frameIndex = probe.frameCount - 1;
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-sseof', '-1',
    '-i', input.file,
    '-update', '1',
    '-q:v', '2',
    input.dest,
  ]);
  return {
    path: input.dest,
    frameIndex,
    framePts: frameIndex / probe.fps,
    fps: probe.fps,
  };
}

export async function audioDurationOf(file: string): Promise<number | undefined> {
  return probeAudioDuration(file);
}

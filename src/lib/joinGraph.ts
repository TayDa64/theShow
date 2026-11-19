/**
 * One filter_complex for a join plan. Chain, board-match, and cut are concat.
 * Crossfade is xfade when the binary has it, otherwise a fade plus overlay.
 * Audio at a butt join is a 1-frame quarter-sine fade with no duration change.
 */
import type { JoinPlan, PlannedJoin } from './joinPlan';
import { AUDIO_MICRO_FADE_FRAMES, sameFrameRate } from './joinPlan';

export interface GraphClip {
  inputIndex: number;
  hasAudio: boolean;
  sourceFps: number;
  startFrame: number;
  endFrame: number;
  outputFrames: number;
}

export interface JoinGraphInput {
  plan: JoinPlan;
  clips: GraphClip[];
  outputWidth: number;
  outputHeight: number;
  xfadeAvailable: boolean;
  sampleRate?: number;
}

export interface JoinGraph {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string;
  usesXfade: boolean;
  usesFpsFilter: boolean;
}

const SAMPLE_RATE = 48000;

function seconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(6);
}

function butt(join: PlannedJoin | undefined): boolean {
  if (!join) return false;
  return join.applied === 'chain' || join.applied === 'board-match' || join.applied === 'cut';
}

function audioTap(input: {
  streamIndex: number;
  labelIndex: number;
  hasAudio: boolean;
  frames: number;
  fps: number;
  sampleRate: number;
  fadeIn: boolean;
  fadeOut: boolean;
}): string {
  const samples = Math.max(1, Math.round(input.frames / input.fps * input.sampleRate));
  const fadeSamples = Math.max(1, Math.round(input.sampleRate / input.fps * AUDIO_MICRO_FADE_FRAMES));
  const fade = Math.min(fadeSamples, Math.max(1, samples - 1));
  const fades: string[] = [];
  if (input.fadeIn) fades.push(`afade=t=in:ss=0:ns=${fade}:curve=qsin`);
  if (input.fadeOut) fades.push(`afade=t=out:ss=${Math.max(samples - fade, 0)}:ns=${fade}:curve=qsin`);
  const fadeChain = fades.length ? `,${fades.join(',')}` : '';
  const label = `[a${input.labelIndex}]`;
  if (input.hasAudio) {
    return `[${input.streamIndex}:a]aformat=sample_fmts=fltp:sample_rates=${input.sampleRate}:channel_layouts=stereo,atrim=end_sample=${samples},apad=whole_len=${samples},asetpts=PTS-STARTPTS${fadeChain}${label}`;
  }
  return `anullsrc=channel_layout=stereo:sample_rate=${input.sampleRate},atrim=end_sample=${samples},asetpts=PTS-STARTPTS${fadeChain}${label}`;
}

function emulateCrossfade(input: {
  filters: string[];
  left: string;
  right: string;
  leftFrames: number;
  fadeFrames: number;
  fps: number;
  label: string;
  token: number;
}): void {
  const { filters, token } = input;
  const duration = seconds(input.fadeFrames, input.fps);
  const headEnd = input.leftFrames - input.fadeFrames;
  filters.push(`[${input.left}]split[${token}lh][${token}lt]`);
  filters.push(`[${input.right}]split[${token}rh][${token}rt]`);
  filters.push(`[${token}lh]trim=end_frame=${headEnd},setpts=PTS-STARTPTS[${token}head]`);
  filters.push(`[${token}lt]trim=start_frame=${headEnd},setpts=PTS-STARTPTS,format=yuva420p,fade=t=out:st=0:d=${duration}:alpha=1[${token}af]`);
  filters.push(`[${token}rh]trim=end_frame=${input.fadeFrames},setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=${duration}:alpha=1[${token}bf]`);
  filters.push(`[${token}rt]trim=start_frame=${input.fadeFrames},setpts=PTS-STARTPTS[${token}tail]`);
  filters.push(`[${token}af][${token}bf]overlay=eof_action=pass:format=auto,format=yuv420p[${token}mid]`);
  filters.push(`[${token}head][${token}mid][${token}tail]concat=n=3:v=1:a=0[${input.label}]`);
}

export function buildJoinFilterGraph(input: JoinGraphInput): JoinGraph {
  const fps = input.plan.outputFps;
  const sampleRate = input.sampleRate ?? SAMPLE_RATE;
  const filters: string[] = [];
  let usesFpsFilter = false;
  input.clips.forEach((clip, index) => {
    const fpsFilter = sameFrameRate(clip.sourceFps, fps) ? '' : `,fps=${fps}`;
    if (fpsFilter) usesFpsFilter = true;
    filters.push(
      `[${clip.inputIndex}:v]trim=start_frame=${clip.startFrame}:end_frame=${clip.endFrame},setpts=PTS-STARTPTS${fpsFilter},` +
      `scale=${input.outputWidth}:${input.outputHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${input.outputWidth}:${input.outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`,
    );
    const previous = index > 0 ? input.plan.joins[index - 1] : undefined;
    const next = input.plan.joins[index];
    filters.push(audioTap({
      streamIndex: clip.inputIndex,
      labelIndex: index,
      hasAudio: clip.hasAudio,
      frames: clip.outputFrames,
      fps,
      sampleRate,
      fadeIn: butt(previous),
      fadeOut: butt(next),
    }));
  });

  if (input.clips.length === 1) {
    return {
      filterComplex: filters.join(';'),
      videoLabel: 'v0',
      audioLabel: 'a0',
      usesXfade: false,
      usesFpsFilter,
    };
  }

  let video = 'v0';
  let audio = 'a0';
  let videoFrames = input.clips[0].outputFrames;
  let usesXfade = false;
  input.plan.joins.forEach((join, index) => {
    const right = index + 1;
    const videoLabel = index === input.plan.joins.length - 1 ? 'vout' : `vx${index}`;
    const audioLabel = index === input.plan.joins.length - 1 ? 'aout' : `ax${index}`;
    const overlap = join.applied === 'crossfade' || join.applied === 'emulated' ? join.crossfadeFrames : 0;
    if (join.applied === 'crossfade' && input.xfadeAvailable && overlap > 0) {
      usesXfade = true;
      const offset = seconds(Math.max(videoFrames - overlap, 0), fps);
      const duration = seconds(overlap, fps);
      filters.push(`[${video}][v${right}]xfade=transition=fade:duration=${duration}:offset=${offset}[${videoLabel}]`);
      filters.push(`[${audio}][a${right}]acrossfade=d=${duration}:c1=qsin:c2=qsin[${audioLabel}]`);
    } else if (join.applied === 'emulated' && overlap > 0) {
      emulateCrossfade({
        filters,
        left: video,
        right: `v${right}`,
        leftFrames: videoFrames,
        fadeFrames: overlap,
        fps,
        label: videoLabel,
        token: index,
      });
      const duration = seconds(overlap, fps);
      filters.push(`[${audio}][a${right}]acrossfade=d=${duration}:c1=qsin:c2=qsin[${audioLabel}]`);
    } else {
      filters.push(`[${video}][v${right}]concat=n=2:v=1:a=0[${videoLabel}]`);
      filters.push(`[${audio}][a${right}]concat=n=2:v=0:a=1[${audioLabel}]`);
    }
    video = videoLabel;
    audio = audioLabel;
    videoFrames = Math.max(videoFrames - overlap, 0) + input.clips[right].outputFrames;
  });

  return {
    filterComplex: filters.join(';'),
    videoLabel: video,
    audioLabel: audio,
    usesXfade,
    usesFpsFilter,
  };
}

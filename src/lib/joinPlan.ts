/**
 * Frame-exact join plan shared by Studio and MCP.
 * No I/O, no HTTP, no ffmpeg. Inputs and outputs are frame counts.
 *
 * Approved decisions (issue #28):
 * D1 Studio crossfade 0.25 s. MCP fadeDuration default stays 0 and is passed in.
 * D2 Keep the outgoing chain frame, drop the incoming frame 0.
 * D3 Output fps is the shared source fps, or the most common fps when mixed.
 * D4 Output size is the project size when one is set, otherwise the first clip.
 * D5 Timeline labels are read-only. An explicit join override is honored.
 * D6 A chained trim whose source is missing is treated as auto and ignored.
 * D7 Chain auto-detect is a correlation of at least 0.9 on the last 12 frames.
 * D8 assemble_film without a join is auto.
 * D9 Butt joins use a 1-frame equal-power audio fade and do not change duration.
 */

export const STUDIO_CROSSFADE_SECONDS = 0.25;
export const CHAIN_MATCH_THRESHOLD = 0.9;
export const CHAIN_TAIL_FRAMES = 12;
export const AUDIO_MICRO_FADE_FRAMES = 1;

export type JoinKind = 'chain' | 'board-match' | 'cut' | 'crossfade';
export type JoinRequest = 'auto' | JoinKind;
export type JoinApplied = JoinKind | 'emulated';
export type TrimEndSource = 'auto' | 'user';

export interface ClipJoinInput {
  frameCount: number;
  fps: number;
  /** Inclusive source frame. Defaults to 0. */
  trimStartFrame?: number;
  /** Exclusive source frame. Defaults to frameCount. */
  trimEndFrame?: number;
  trimEndSource?: TrimEndSource;
  /** Join from the previous clip into this one. Ignored on the first clip. */
  join?: JoinRequest;
  /** Source frame in THIS clip that the next clip was rendered from. */
  chainFrameIndex?: number;
  /** Set when local correlation found a chain frame in the previous clip. */
  detectedChainFrame?: number;
  /** Studio previous-shot, or MCP openingFramePath === previous framePath. */
  chainedFromPrevious?: boolean;
  /** shots[i-1].lastFrameUrl === shots[i].firstFrameUrl. */
  boardMatch?: boolean;
}

export interface PlanJoinsInput {
  clips: ClipJoinInput[];
  crossfadeSeconds: number;
  outputFps: number;
  xfadeAvailable: boolean;
}

export interface PlannedSegment {
  clipIndex: number;
  /** Inclusive source frame. */
  startFrame: number;
  /** Exclusive source frame. */
  endFrame: number;
  /** Frames this segment contributes at outputFps, before a crossfade overlap. */
  frameCount: number;
}

export interface PlannedJoin {
  index: number;
  type: JoinKind;
  requested: JoinRequest;
  applied: JoinApplied;
  reason?: string;
  chainFrameIndex?: number;
  detected?: boolean;
  crossfadeFrames: number;
  offsetFrames: number;
  label: string;
  accessibleName: string;
}

export interface JoinPlan {
  outputFps: number;
  crossfadeSeconds: number;
  segments: PlannedSegment[];
  joins: PlannedJoin[];
  totalFrames: number;
}

export function chooseOutputFps(rates: number[]): number {
  if (rates.length === 0) return 24;
  const grouped = new Map<number, { count: number; first: number }>();
  rates.forEach((rate, index) => {
    const key = Math.round(rate * 1000) / 1000;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { count: 1, first: index });
  });
  let bestRate = Math.round(rates[0] * 1000) / 1000;
  let bestCount = -1;
  let bestFirst = Number.POSITIVE_INFINITY;
  for (const [rate, info] of grouped) {
    if (info.count > bestCount || (info.count === bestCount && info.first < bestFirst)) {
      bestRate = rate;
      bestCount = info.count;
      bestFirst = info.first;
    }
  }
  return bestRate;
}

export function sameFrameRate(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

export function chooseOutputSize(input: {
  project?: { width: number; height: number } | null;
  first: { width: number; height: number };
}): { width: number; height: number } {
  const project = input.project;
  if (project) {
    return { width: Math.round(project.width), height: Math.round(project.height) };
  }
  return {
    width: Math.max(2, Math.round(input.first.width)),
    height: Math.max(2, Math.round(input.first.height)),
  };
}

/** First source frame whose pts is at or after `seconds`. */
export function frameIndexAtOrAfter(seconds: number, fps: number): number {
  if (!(fps > 0) || !(seconds > 0)) return 0;
  return Math.max(0, Math.ceil(seconds * fps - 1e-6));
}

/** First source frame whose pts is at or after `seconds` (exclusive trim end). */
export function exclusiveFrameAt(seconds: number, fps: number): number {
  if (!(fps > 0)) return 0;
  if (!(seconds > 0)) return 0;
  return Math.max(0, Math.ceil(seconds * fps - 1e-6));
}

export function outputFramesFor(sourceFrames: number, sourceFps: number, outputFps: number): number {
  if (sourceFrames <= 0) return 0;
  if (sameFrameRate(sourceFps, outputFps)) return sourceFrames;
  return Math.max(1, Math.round(sourceFrames * outputFps / sourceFps));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  return `${Number(rounded.toFixed(3))} s`;
}

export function joinPresentation(index: number, kind: 'chain' | 'board-match' | 'cut' | 'crossfade' | 'broken', crossfadeSeconds = 0): { label: string; accessibleName: string } {
  const from = index + 1;
  const to = index + 2;
  switch (kind) {
    case 'chain':
      return {
        label: 'Exact frame join (chained)',
        accessibleName: `Join ${from} → ${to}: exact frame join (chained)`,
      };
    case 'board-match':
      return {
        label: 'Matched board frame',
        accessibleName: `Join ${from} → ${to}: matched board frame`,
      };
    case 'cut':
      return {
        label: 'Cut',
        accessibleName: `Join ${from} → ${to}: cut`,
      };
    case 'crossfade':
      return {
        label: `Crossfade ${formatSeconds(crossfadeSeconds)}`,
        accessibleName: `Join ${from} → ${to}: crossfade ${formatSeconds(crossfadeSeconds)}`,
      };
    case 'broken':
      return {
        label: 'Chain broken by trim',
        accessibleName: `Join ${from} → ${to}: chain broken by trim`,
      };
    default: {
      const unexpected: never = kind;
      throw new Error(`Unexpected join presentation ${unexpected}`);
    }
  }
}

interface ClassifiedJoin {
  requested: JoinRequest;
  type: JoinKind;
  applied: JoinApplied;
  reason?: string;
  chainFrameIndex?: number;
  detected?: boolean;
  brokenByTrim: boolean;
  intactSeam: boolean;
}

function classifyJoin(prev: ClipJoinInput, next: ClipJoinInput, crossfadeSeconds: number, xfadeAvailable: boolean, index: number): ClassifiedJoin {
  const requested = next.join ?? 'auto';
  const recorded = Number.isInteger(prev.chainFrameIndex) ? prev.chainFrameIndex : undefined;
  const detected = Number.isInteger(next.detectedChainFrame) ? next.detectedChainFrame : undefined;
  const userTrim = prev.trimEndSource === 'user';

  const chainIndex = recorded ?? detected;
  const detectedUsed = recorded === undefined && detected !== undefined;

  let type: JoinKind = 'cut';
  let reason: string | undefined;
  let usedIndex: number | undefined;
  let detectedFlag = false;

  if (requested === 'cut') {
    type = 'cut';
  } else if (requested === 'crossfade') {
    type = crossfadeSeconds > 0 ? 'crossfade' : 'cut';
  } else if (requested === 'board-match' || (requested === 'auto' && next.boardMatch)) {
    type = 'board-match';
    usedIndex = chainIndex ?? Math.max((prev.frameCount || 1) - 1, 0);
    detectedFlag = detectedUsed && recorded === undefined && detected !== undefined && usedIndex === detected;
  } else if (requested === 'chain' || requested === 'auto') {
    const hinted = requested === 'chain' || Boolean(next.chainedFromPrevious);
    if (chainIndex !== undefined && (hinted || detected !== undefined || recorded !== undefined)) {
      type = 'chain';
      usedIndex = chainIndex;
      detectedFlag = detectedUsed;
    } else if (hinted) {
      type = crossfadeSeconds > 0 ? 'crossfade' : 'cut';
      reason = 'chain-frame-unresolved';
    } else if (crossfadeSeconds > 0) {
      type = 'crossfade';
    } else {
      type = 'cut';
    }
  } else {
    const unexpected: never = requested;
    throw new Error(`Unexpected join request ${unexpected}`);
  }

  if ((type === 'chain' || type === 'board-match') && userTrim) {
    type = crossfadeSeconds > 0 ? 'crossfade' : 'cut';
    reason = 'chain-broken-by-trim';
    usedIndex = undefined;
    detectedFlag = false;
  }

  let applied: JoinApplied = type;
  if (type === 'crossfade' && !xfadeAvailable) {
    applied = 'emulated';
    reason = reason ?? 'xfade-unavailable';
  }

  const intactSeam = (type === 'chain' || type === 'board-match') && reason !== 'chain-broken-by-trim';
  return {
    requested,
    type,
    applied,
    reason,
    chainFrameIndex: intactSeam ? usedIndex : undefined,
    detected: intactSeam ? detectedFlag : undefined,
    brokenByTrim: reason === 'chain-broken-by-trim',
    intactSeam,
  };
}

function sourceWindow(clip: ClipJoinInput, incomingSeam: boolean, outgoing: ClassifiedJoin | undefined): { start: number; end: number } {
  const frameCount = Math.max(clip.frameCount, 1);
  let start = clamp(clip.trimStartFrame ?? 0, 0, frameCount - 1);
  let end = clamp(clip.trimEndFrame ?? frameCount, start + 1, frameCount);
  if (outgoing?.intactSeam && outgoing.chainFrameIndex !== undefined && clip.trimEndSource !== 'user') {
    const through = clamp(outgoing.chainFrameIndex + 1, 1, frameCount);
    end = through;
    if (end <= start) end = Math.min(frameCount, start + 1);
  }
  if (incomingSeam && start === 0 && end > 1) start = 1;
  if (end <= start) end = Math.min(frameCount, start + 1);
  return { start, end };
}

export function planJoins(input: PlanJoinsInput): JoinPlan {
  if (input.clips.length < 1) {
    throw new Error('At least one clip is required to assemble a film.');
  }
  const outputFps = input.outputFps > 0 ? input.outputFps : 24;
  const classified: Array<ClassifiedJoin | undefined> = input.clips.map((clip, index) => {
    if (index === 0) return undefined;
    return classifyJoin(input.clips[index - 1], clip, input.crossfadeSeconds, input.xfadeAvailable, index - 1);
  });

  const windows = input.clips.map((clip, index) => sourceWindow(
    clip,
    Boolean(classified[index]?.intactSeam),
    classified[index + 1],
  ));

  const segments: PlannedSegment[] = windows.map((window, index) => {
    const clip = input.clips[index];
    const sourceFrames = window.end - window.start;
    return {
      clipIndex: index,
      startFrame: window.start,
      endFrame: window.end,
      frameCount: outputFramesFor(sourceFrames, clip.fps, outputFps),
    };
  });

  const joins: PlannedJoin[] = [];
  let elapsed = segments[0]?.frameCount ?? 0;
  for (let index = 1; index < input.clips.length; index += 1) {
    const decision = classified[index];
    if (!decision) continue;
    const left = segments[index - 1].frameCount;
    const right = segments[index].frameCount;
    let crossfadeFrames = 0;
    if (decision.type === 'crossfade') {
      const requestedFrames = Math.max(0, Math.round(input.crossfadeSeconds * outputFps));
      const maxFrames = Math.max(0, Math.min(left, right) - 1);
      crossfadeFrames = Math.min(requestedFrames, maxFrames);
      if (crossfadeFrames <= 0) {
        decision.type = 'cut';
        decision.applied = 'cut';
        decision.intactSeam = false;
      }
    }
    const presentationKind = decision.brokenByTrim
      ? 'broken'
      : decision.type === 'chain'
        ? 'chain'
        : decision.type === 'board-match'
          ? 'board-match'
          : decision.type === 'crossfade'
            ? 'crossfade'
            : 'cut';
    const presentation = joinPresentation(index - 1, presentationKind, input.crossfadeSeconds);
    const offsetFrames = Math.max(0, elapsed - crossfadeFrames);
    joins.push({
      index: index - 1,
      type: decision.type,
      requested: decision.requested,
      applied: decision.applied,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.chainFrameIndex !== undefined && decision.intactSeam ? { chainFrameIndex: decision.chainFrameIndex } : {}),
      ...(decision.detected ? { detected: true } : {}),
      crossfadeFrames,
      offsetFrames,
      label: presentation.label,
      accessibleName: presentation.accessibleName,
    });
    elapsed = offsetFrames + right;
  }

  return {
    outputFps,
    crossfadeSeconds: input.crossfadeSeconds,
    segments,
    joins,
    totalFrames: input.clips.length === 1 ? segments[0].frameCount : elapsed,
  };
}

export function assemblyMode(plan: JoinPlan): 'single' | 'concat' | 'xfade' | 'emulated' {
  if (plan.segments.length <= 1) return 'single';
  if (plan.joins.some((join) => join.applied === 'emulated')) return 'emulated';
  if (plan.joins.some((join) => join.applied === 'crossfade')) return 'xfade';
  return 'concat';
}

export function assemblyNotice(joins: PlannedJoin[]): string | undefined {
  const affected = joins.filter((join) => join.reason === 'xfade-unavailable' || join.applied === 'emulated');
  if (affected.length === 0) return undefined;
  if (affected.some((join) => join.applied === 'emulated')) {
    return 'Crossfades were emulated because this ffmpeg has no xfade filter. Chain and cut joins are unchanged.';
  }
  return 'Crossfades became hard cuts because this ffmpeg has no xfade filter. Chain and cut joins are unchanged.';
}

export interface TimelineJoinInput {
  index: number;
  join?: JoinRequest;
  chained: boolean;
  boardMatch?: boolean;
  trimEndSource?: TrimEndSource;
  crossfadeSeconds: number;
}

/** Read-only timeline label. Detection happens later, at assembly. */
export function timelineJoinPresentation(input: TimelineJoinInput): { label: string; accessibleName: string } {
  const requested = input.join ?? 'auto';
  const broken = input.trimEndSource === 'user' && (requested === 'chain' || requested === 'board-match' || ((requested === 'auto') && (input.chained || input.boardMatch)));
  if (broken) return joinPresentation(input.index, 'broken', input.crossfadeSeconds);
  if (requested === 'chain' || (requested === 'auto' && input.chained)) {
    return joinPresentation(input.index, 'chain', input.crossfadeSeconds);
  }
  if (requested === 'board-match' || (requested === 'auto' && input.boardMatch)) {
    return joinPresentation(input.index, 'board-match', input.crossfadeSeconds);
  }
  if (requested === 'cut' || input.crossfadeSeconds <= 0) {
    return joinPresentation(input.index, 'cut', input.crossfadeSeconds);
  }
  if (requested === 'crossfade' || requested === 'auto') {
    return joinPresentation(input.index, 'crossfade', input.crossfadeSeconds);
  }
  const unexpected: never = requested;
  throw new Error(`Unexpected timeline join ${unexpected}`);
}

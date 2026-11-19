import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { assemblePlanned, extractExactLastFrame } from './assembleShared';
import { STUDIO_CROSSFADE_SECONDS, type JoinRequest, type PlannedJoin, type TrimEndSource } from './joinPlan';
import type { ChainedClip } from '../types/pipeline';

export const FADE_DURATION = STUDIO_CROSSFADE_SECONDS;
export const STUDIO_DEFAULT_CROSSFADE_SECONDS = STUDIO_CROSSFADE_SECONDS;

export interface StudioAssembleClip extends ChainedClip {
  filePath: string;
  trimEndSource?: TrimEndSource;
  join?: JoinRequest;
  chainFrameIndex?: number;
  chainedFromPrevious?: boolean;
  boardMatch?: boolean;
}

export interface StudioAssembleResult {
  filmId: string;
  outputPath: string;
  mode: 'single' | 'concat' | 'xfade' | 'emulated';
  joins: PlannedJoin[];
  notice?: string;
  outputFps: number;
  totalFrames: number;
  durationSeconds: number;
  filterGraph: string;
  hasXfade: boolean;
}

export async function assembleFilm(
  clips: StudioAssembleClip[],
  outputDir: string,
  filmId = uuidv4(),
  options?: {
    crossfadeSeconds?: number;
    outputSize?: { width: number; height: number } | null;
  },
): Promise<StudioAssembleResult> {
  if (clips.length < 1) {
    throw new Error('At least one clip is required to assemble a film.');
  }
  const outputPath = path.join(outputDir, `${filmId}.mp4`);
  const assembled = await assemblePlanned({
    clips: clips.map((clip) => ({
      file: clip.filePath,
      trimStart: clip.trimStartSeconds,
      trimEnd: clip.trimEndSeconds,
      trimEndSource: clip.trimEndSource,
      join: clip.join,
      chainFrameIndex: clip.chainFrameIndex,
      chainedFromPrevious: clip.chainedFromPrevious,
      boardMatch: clip.boardMatch,
    })),
    crossfadeSeconds: options?.crossfadeSeconds ?? STUDIO_CROSSFADE_SECONDS,
    outputPath,
    outputSize: options?.outputSize,
  });
  return {
    filmId,
    outputPath: assembled.path,
    mode: assembled.mode,
    joins: assembled.joins,
    ...(assembled.notice ? { notice: assembled.notice } : {}),
    outputFps: assembled.outputFps,
    totalFrames: assembled.totalFrames,
    durationSeconds: assembled.durationSeconds,
    filterGraph: assembled.filterGraph,
    hasXfade: assembled.hasXfade,
  };
}

export async function extractLastFrame(inputPath: string, outputPath?: string): Promise<{
  path: string;
  frameIndex: number;
  framePts: number;
}> {
  const finalOutputPath = outputPath || path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}-frame-${uuidv4()}.png`,
  );
  const frame = await extractExactLastFrame({ file: inputPath, dest: finalOutputPath });
  return { path: frame.path, frameIndex: frame.frameIndex, framePts: frame.framePts };
}

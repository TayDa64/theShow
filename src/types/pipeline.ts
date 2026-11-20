import type { JoinRequest, PlannedJoin, TrimEndSource } from '../lib/joinPlan';

export type PipelineStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ChainedClip {
  clipId?: string;
  sceneId?: string;
  shotId: string;
  title: string;
  order: number;
  clipUrl?: string;
  filePath?: string;
  operationName?: string | null;
  durationSeconds?: number;
  sourceDurationSeconds?: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  trimEndSource?: TrimEndSource;
  playbackDurationSeconds?: number;
  bridgeFrameUrl?: string | null;
  join?: JoinRequest;
  /** Chain frame inside this clip, used by the join into the next clip. */
  chainFrameIndex?: number;
  chainedFromPrevious?: boolean;
  boardMatch?: boolean;
  crossfadeSeconds?: number;
}

export interface FilmAssemblyJob {
  filmId: string;
  status: PipelineStatus;
  clipCount: number;
  downloadUrl?: string;
  outputPath?: string;
  error?: string | null;
  mode?: 'single' | 'concat' | 'xfade' | 'emulated';
  joins?: PlannedJoin[];
  notice?: string | null;
  outputFps?: number;
}

export interface ExtendClipRequest {
  prompt: string;
  videoToExtend: string;
  firstFrame?: string | null;
  aspectRatio?: '16:9' | '9:16';
  durationSeconds?: number;
  seed?: number | null;
  referenceImages?: string[];
}

export interface AssembleFilmRequest {
  title?: string;
  clips: ChainedClip[];
  aspectRatio?: '16:9' | '9:16';
  crossfadeSeconds?: number;
  outputSize?: { width: number; height: number } | null;
}

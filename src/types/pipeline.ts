export type PipelineStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ChainedClip {
  shotId: string;
  title: string;
  order: number;
  clipUrl?: string;
  filePath?: string;
  operationName?: string | null;
  durationSeconds?: number;
  bridgeFrameUrl?: string | null;
}

export interface FilmAssemblyJob {
  filmId: string;
  status: PipelineStatus;
  clipCount: number;
  downloadUrl?: string;
  outputPath?: string;
  error?: string | null;
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
}

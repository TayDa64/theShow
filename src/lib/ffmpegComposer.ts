import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import type { ChainedClip } from '../types/pipeline';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const FADE_DURATION = 0.5;

export function buildAssemblyFilterGraph(clips: Pick<ChainedClip, 'durationSeconds'>[]) {
  if (!clips.length) {
    throw new Error('At least one clip is required to assemble a film.');
  }

  const filters: string[] = [];
  let currentVideoLabel = 'v0';
  let currentAudioLabel = 'a0';

  filters.push('[0:v]format=yuv420p,setsar=1[v0]');
  filters.push('[0:a]aresample=async=1:first_pts=0[a0]');

  for (let index = 1; index < clips.length; index += 1) {
    filters.push(`[${index}:v]format=yuv420p,setsar=1[v${index}]`);
    filters.push(`[${index}:a]aresample=async=1:first_pts=0[a${index}]`);

    const offset = clips.slice(0, index).reduce((total, clip) => total + Number(clip.durationSeconds || 0), 0) - (FADE_DURATION * index);
    const nextVideoLabel = index === clips.length - 1 ? 'vout' : `vx${index}`;
    const nextAudioLabel = index === clips.length - 1 ? 'aout' : `ax${index}`;

    filters.push(`[${currentVideoLabel}][v${index}]xfade=transition=dissolve:duration=${FADE_DURATION}:offset=${offset}[${nextVideoLabel}]`);
    filters.push(`[${currentAudioLabel}][a${index}]acrossfade=d=${FADE_DURATION}:c1=tri:c2=tri[${nextAudioLabel}]`);

    currentVideoLabel = nextVideoLabel;
    currentAudioLabel = nextAudioLabel;
  }

  if (clips.length === 1) {
    filters.push('[v0]copy[vout]');
    filters.push('[a0]acopy[aout]');
  }

  return {
    filterComplex: filters.join(';'),
    videoLabel: 'vout',
    audioLabel: 'aout',
  };
}

export async function assembleFilm(clips: Array<ChainedClip & { filePath: string }>, outputDir: string, filmId = uuidv4()) {
  if (clips.length < 1) {
    throw new Error('At least one clip is required to assemble a film.');
  }

  await fs.promises.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${filmId}.mp4`);
  const graph = buildAssemblyFilterGraph(clips);

  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg();
    clips.forEach((clip) => command.input(clip.filePath));

    command
      .complexFilter(graph.filterComplex)
      .outputOptions([
        `-map [${graph.videoLabel}]`,
        `-map [${graph.audioLabel}]`,
        '-c:v libx264',
        '-c:a aac',
        '-movflags +faststart',
      ])
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .save(outputPath);
  });

  return {
    filmId,
    outputPath,
  };
}

export async function extractLastFrame(inputPath: string, outputPath?: string) {
  const finalOutputPath = outputPath || path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}-frame-${uuidv4()}.png`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions(['-sseof', '-0.1'])
      .outputOptions(['-frames:v', '1'])
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .save(finalOutputPath);
  });

  return finalOutputPath;
}

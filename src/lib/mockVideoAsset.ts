import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

export type MockVideoAspectRatio = '16:9' | '9:16';

interface EnsureMockVideoAssetOptions {
  cacheDir: string;
  operationName: string;
  aspectRatio?: MockVideoAspectRatio;
  durationSeconds?: number;
}

const inFlightMockVideoGenerations = new Map<string, Promise<string>>();

export function normalizeMockVideoAspectRatio(value: unknown): MockVideoAspectRatio {
  return value === '9:16' ? '9:16' : '16:9';
}

export function normalizeMockVideoDuration(value: unknown, fallback = 8): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(parsed), 1), 30);
}

function getMockVideoResolution(aspectRatio: MockVideoAspectRatio) {
  return aspectRatio === '9:16' ? '540x960' : '960x540';
}

function buildMockVideoCacheFileName(operationName: string, aspectRatio: MockVideoAspectRatio, durationSeconds: number) {
  const digest = createHash('sha1')
    .update(JSON.stringify({ operationName, aspectRatio, durationSeconds }))
    .digest('hex');

  return `${digest}.mp4`;
}

async function runFfmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegInstaller.path, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

export async function ensureMockVideoAsset(options: EnsureMockVideoAssetOptions) {
  const aspectRatio = normalizeMockVideoAspectRatio(options.aspectRatio);
  const durationSeconds = normalizeMockVideoDuration(options.durationSeconds, 8);

  await fs.promises.mkdir(options.cacheDir, { recursive: true });

  const outputPath = path.join(
    options.cacheDir,
    buildMockVideoCacheFileName(options.operationName, aspectRatio, durationSeconds),
  );

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const existingGeneration = inFlightMockVideoGenerations.get(outputPath);
  if (existingGeneration) {
    return existingGeneration;
  }

  const generationPromise = (async () => {
    if (fs.existsSync(outputPath)) {
      return outputPath;
    }

    const tempOutputPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;

    try {
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${getMockVideoResolution(aspectRatio)}:rate=24`,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t',
        String(durationSeconds),
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        tempOutputPath,
      ]);

      try {
        await fs.promises.rename(tempOutputPath, outputPath);
      } catch (error: any) {
        if (fs.existsSync(outputPath)) {
          await fs.promises.rm(tempOutputPath, { force: true });
        } else {
          throw error;
        }
      }

      return outputPath;
    } catch (error) {
      await fs.promises.rm(tempOutputPath, { force: true });
      throw error;
    } finally {
      inFlightMockVideoGenerations.delete(outputPath);
    }
  })();

  inFlightMockVideoGenerations.set(outputPath, generationPromise);
  return generationPromise;
}

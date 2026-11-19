import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAIN_MATCH_THRESHOLD, CHAIN_TAIL_FRAMES } from './joinPlan';
import { correlateGrayBuffers } from './frameMatch';
import { resolveTools } from './ffmpegResolve';

const exec = promisify(execFile);
const RGB_FRAME_BYTES = 32 * 32 * 3;

export interface ChainScore {
  index: number;
  correlation: number;
}

/**
 * Among scores at or above the threshold, keep the latest frame of the best
 * correlation. Equal scores, within the 0.001 rounding of the gray correlation,
 * are a tie and the later frame wins. An earlier frame used to win, which
 * pulled a low-texture chain back to the start of the 12-frame window.
 */
export function chooseChainIndex(scores: ChainScore[], threshold: number): ChainScore | undefined {
  let best: ChainScore | undefined;
  for (const score of scores) {
    if (score.correlation < threshold) continue;
    const better = best === undefined || score.correlation > best.correlation + 0.001;
    const tied = best !== undefined && Math.abs(score.correlation - best.correlation) <= 0.001 && score.index > best.index;
    if (better || tied) best = score;
  }
  return best;
}

function meanAbs(left: Buffer, right: Buffer): number {
  let difference = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference += Math.abs(left[index] - right[index]);
  return difference / length;
}

function grayFromRgb(rgb: Buffer): Buffer {
  const gray = Buffer.alloc(rgb.length / 3);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 3;
    gray[index] = Math.round((rgb[offset] * 0.299) + (rgb[offset + 1] * 0.587) + (rgb[offset + 2] * 0.114));
  }
  return gray;
}

/** A flat pair has no Pearson correlation. One level of difference is still the same picture. */
function flatFrameMatch(left: Buffer, right: Buffer): number | undefined {
  if (left.length < 1024 || right.length < 1024) return undefined;
  let difference = 0;
  for (let index = 0; index < 1024; index += 1) difference += Math.abs(left[index] - right[index]);
  return difference / 1024 <= 1 ? 1 : undefined;
}

function splitRgb(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset + RGB_FRAME_BYTES <= buffer.length; offset += RGB_FRAME_BYTES) {
    frames.push(Buffer.from(buffer.subarray(offset, offset + RGB_FRAME_BYTES)));
  }
  return frames;
}

async function readRgb(file: string, videoFilter: string, inputArgs: string[] = [], frameLimit?: number): Promise<Buffer> {
  const { ffmpeg } = await resolveTools();
  const limit = frameLimit === undefined ? [] : ['-frames:v', String(frameLimit)];
  const { stdout } = await exec(ffmpeg, [
    '-v', 'error',
    ...inputArgs,
    '-i', file,
    '-map', '0:v:0',
    '-an',
    '-vf', videoFilter,
    ...limit,
    '-f', 'rawvideo',
    '-',
  ], { encoding: 'buffer', maxBuffer: 8 << 20 });
  return stdout as unknown as Buffer;
}

export interface ChainDetection {
  index: number;
  correlation: number;
}

/**
 * Compare the incoming clip's frame 0 with the outgoing clip's last 12 frames.
 * One seek reads that tail. Frame 0 is read once. The best correlation at or
 * above the threshold wins, and a tie keeps the later frame.
 */
export async function detectChainFrame(input: {
  outgoingFile: string;
  incomingFile: string;
  outgoingFrameCount: number;
  threshold?: number;
  tail?: number;
}): Promise<ChainDetection | undefined> {
  const threshold = input.threshold ?? CHAIN_MATCH_THRESHOLD;
  const tail = input.tail ?? CHAIN_TAIL_FRAMES;
  try {
    const [incomingRaw, tailRaw] = await Promise.all([
      readRgb(input.incomingFile, 'select=eq(n\\,0),scale=32:32,format=rgb24', [], 1),
      readRgb(input.outgoingFile, 'scale=32:32,format=rgb24', ['-sseof', '-1']),
    ]);
    const incoming = splitRgb(incomingRaw)[0];
    const outgoing = splitRgb(tailRaw).slice(-tail);
    if (!incoming || outgoing.length === 0) return undefined;
    const incomingGray = grayFromRgb(incoming);
    const firstIndex = Math.max(input.outgoingFrameCount - outgoing.length, 0);
    const scores: ChainScore[] = [];
    outgoing.forEach((frame, offset) => {
      if (meanAbs(frame, incoming) > 18) return;
      const correlation = correlateGrayBuffers(grayFromRgb(frame), incomingGray) ?? flatFrameMatch(grayFromRgb(frame), incomingGray);
      if (correlation === undefined) return;
      scores.push({ index: firstIndex + offset, correlation });
    });
    return chooseChainIndex(scores, threshold);
  } catch {
    return undefined;
  }
}

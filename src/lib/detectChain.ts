import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAIN_MATCH_THRESHOLD, CHAIN_TAIL_FRAMES } from './joinPlan';
import { correlateGrayBuffers } from './frameMatch';
import { readGrayFrame, readGrayTail, resolveTools } from './ffmpegResolve';

const exec = promisify(execFile);

async function readRgbFrame(file: string, frameIndex: number): Promise<Buffer | undefined> {
  const { ffmpeg } = await resolveTools();
  const { stdout } = await exec(ffmpeg, [
    '-v', 'error',
    '-i', file,
    '-map', '0:v:0',
    '-an',
    '-vf', `select=eq(n\\,${frameIndex}),scale=32:32,format=rgb24`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-',
  ], { encoding: 'buffer', maxBuffer: 4 << 20 });
  const buffer = stdout as unknown as Buffer;
  return buffer.length >= 32 * 32 * 3 ? buffer.subarray(0, 32 * 32 * 3) : undefined;
}

function meanAbs(left: Buffer, right: Buffer): number {
  let difference = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference += Math.abs(left[index] - right[index]);
  return difference / length;
}

/** Identical flat frames have no Pearson correlation. A mean difference of one level is still the same picture. */
function flatFrameMatch(left: Buffer, right: Buffer): number | undefined {
  if (left.length < 1024 || right.length < 1024) return undefined;
  let difference = 0;
  for (let index = 0; index < 1024; index += 1) difference += Math.abs(left[index] - right[index]);
  return difference / 1024 <= 1 ? 1 : undefined;
}

export interface ChainDetection {
  index: number;
  correlation: number;
}

/**
 * Compare the incoming clip's frame 0 with the outgoing clip's last 12 frames.
 * The best correlation at or above the threshold is the chain frame.
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
    const incoming = await readGrayFrame(input.incomingFile, 0);
    const outgoing = await readGrayTail(input.outgoingFile, input.outgoingFrameCount, tail);
    if (incoming.length < 1024 || outgoing.length === 0) return undefined;
    const firstIndex = Math.max(input.outgoingFrameCount - outgoing.length, 0);
    let best: ChainDetection | undefined;
    for (let offset = 0; offset < outgoing.length; offset += 1) {
      const textured = correlateGrayBuffers(outgoing[offset], incoming);
      const correlation = textured ?? flatFrameMatch(outgoing[offset], incoming);
      if (correlation === undefined || correlation < threshold) continue;
      const index = firstIndex + offset;
      const [left, right] = await Promise.all([
        readRgbFrame(input.outgoingFile, index),
        readRgbFrame(input.incomingFile, 0),
      ]);
      if (!left || !right || meanAbs(left, right) > 18) continue;
      if (!best || correlation > best.correlation) best = { index, correlation };
    }
    return best;
  } catch {
    return undefined;
  }
}

#!/usr/bin/env node
/**
 * Print each join in a finished film: type, seam frame, YDIF, and audio drift.
 * Usage: node scripts/check-joins.mjs <film.mp4> [job.json]
 * Offline. It shells out to ffmpeg and ffprobe on the local files.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const film = process.argv[2];
const jobPath = process.argv[3];
if (!film) {
  console.error('Usage: node scripts/check-joins.mjs <film.mp4> [job.json]');
  process.exit(1);
}

function numbers(text, key) {
  return text.split('\n').flatMap((line) => {
    const match = line.match(new RegExp(`${key}=([0-9.]+)`));
    return match ? [Number(match[1])] : [];
  });
}

const probe = await exec('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=codec_type,nb_frames,duration,r_frame_rate',
  '-of', 'default=nw=1',
  film,
]);
const stats = await exec('ffmpeg', [
  '-hide_banner', '-i', film,
  '-vf', 'signalstats,metadata=print:file=-',
  '-f', 'null', '-',
], { maxBuffer: 64 * 1024 * 1024 });
const ydif = numbers(`${stats.stdout}`, 'YDIF');
const video = probe.stdout.match(/codec_type=video[\s\S]*?duration=([0-9.]+)/);
const audio = probe.stdout.match(/codec_type=audio[\s\S]*?duration=([0-9.]+)/);
const videoDuration = video ? Number(video[1]) : undefined;
const audioDuration = audio ? Number(audio[1]) : undefined;
const rate = probe.stdout.match(/r_frame_rate=(\d+)\/(\d+)/);
const fps = rate ? Number(rate[1]) / Number(rate[2]) : 24;
const median = ydif.length ? [...ydif].sort((a, b) => a - b)[Math.floor(ydif.length / 2)] : undefined;

let joins = [];
if (jobPath) {
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  joins = Array.isArray(job.joins) ? job.joins : [];
}

console.log(JSON.stringify({
  film,
  fps,
  frames: ydif.length,
  videoDuration,
  audioDuration,
  driftSeconds: videoDuration !== undefined && audioDuration !== undefined ? Number((videoDuration - audioDuration).toFixed(6)) : undefined,
  medianYdif: median,
  joins: joins.map((join) => {
    const frame = Math.round((join.offsetFrames ?? 0));
    return {
      index: join.index,
      type: join.type,
      applied: join.applied,
      reason: join.reason,
      chainFrameIndex: join.chainFrameIndex,
      detected: join.detected,
      offsetFrames: join.offsetFrames,
      seamYdif: ydif[frame],
    };
  }),
}, null, 2));

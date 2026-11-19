import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleClips, extractLastFrame as extractMcpFrame } from '../mcp/media';
import { assembleFilm, extractLastFrame as extractStudioFrame } from '../src/lib/ffmpegComposer';
import { assemblePlanned } from '../src/lib/assembleShared';
import { probeVideo, resetToolCache } from '../src/lib/ffmpegResolve';
import { app } from '../server';

const exec = promisify(execFile);
const BUNDLED = path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');

function luma(index: number): number {
  return 16 + ((index * 3) % 220);
}

async function yavgs(file: string): Promise<number[]> {
  const result = await exec('ffmpeg', [
    '-hide_banner', '-i', file,
    '-vf', 'signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  const text = `${result.stdout ?? ''}`;
  return text.split('\n').flatMap((line) => {
    const match = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    return match ? [Number(match[1])] : [];
  });
}

function filmPath(result: { path?: string; outputPath?: string }): string {
  return result.outputPath ?? result.path ?? '';
}

function expectIndices(values: number[], start: number): void {
  expect(values.length).toBeGreaterThan(0);
  values.forEach((value, offset) => {
    expect(Math.abs(value - luma(start + offset))).toBeLessThanOrEqual(0.5);
  });
}

async function indexClip(file: string, options: {
  start?: number;
  frames: number;
  fps?: number;
  width?: number;
  height?: number;
  audioSeconds?: number;
  sampleRate?: number;
  channels?: number;
  sar?: string;
  hue?: number;
}): Promise<void> {
  const fps = options.fps ?? 24;
  const width = options.width ?? 320;
  const height = options.height ?? 180;
  const start = options.start ?? 0;
  const audioSeconds = options.audioSeconds ?? options.frames / fps;
  const rate = options.sampleRate ?? 48000;
  const layout = options.channels === 1 ? 'mono' : 'stereo';
  const sar = options.sar ? `:sar=${options.sar}` : '';
  const hue = options.hue ? `,hue=h=${options.hue}` : '';
  await exec('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i',
    `nullsrc=s=${width}x${height}:r=${fps}${sar},geq=lum='16+mod((N+${start})*3\\,220)':cb=128:cr=128${hue}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${audioSeconds}`,
    '-frames:v', String(options.frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', options.channels === 1 ? '1' : '2', '-ar', String(rate),
    file,
  ]);
}

async function withDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'joins-'));
}

async function both(dir: string, name: string, clips: Parameters<typeof assembleClips>[0]['clips'], fade: number) {
  const studio = await assembleFilm(clips.map((clip, index) => ({
    shotId: `shot-${index}`,
    title: `Shot ${index}`,
    order: index,
    filePath: clip.file,
    trimStartSeconds: clip.trimStart,
    trimEndSeconds: clip.trimEnd,
    trimEndSource: clip.trimEndSource,
    join: clip.join,
    chainFrameIndex: clip.chainFrameIndex,
    chainedFromPrevious: clip.chainedFromPrevious,
    boardMatch: clip.boardMatch,
  })), dir, `studio-${name}`, { crossfadeSeconds: fade });
  const mcp = await assembleClips({ clips, fadeDuration: fade });
  return { studio, mcp };
}

describe('frame-exact joins', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    delete process.env.THESHOW_NO_FFPROBE;
    delete process.env.THESHOW_VIDEO_BACKEND;
    resetToolCache();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('joins a chain into consecutive frames 0..384', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 193, audioSeconds: 8 });
    await indexClip(path.join(dir, 'b.mp4'), { start: 192, frames: 193, audioSeconds: 8 });
    const { studio, mcp } = await both(dir, 'chain', [
      { file: path.join(dir, 'a.mp4'), chainFrameIndex: 192 },
      { file: path.join(dir, 'b.mp4'), join: 'chain' },
    ], 0.25);
    for (const result of [studio, mcp]) {
      const frames = await yavgs(filmPath(result));
      expect(frames).toHaveLength(385);
      expectIndices(frames, 0);
      expect(result.joins[0]).toMatchObject({ type: 'chain', applied: 'chain', crossfadeFrames: 0 });
    }
  }, 60_000);

  it('detects a legacy N-2 chain frame', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 193, audioSeconds: 8 });
    await indexClip(path.join(dir, 'b.mp4'), { start: 191, frames: 193, audioSeconds: 8 });
    const { studio, mcp } = await both(dir, 'legacy', [
      { file: path.join(dir, 'a.mp4') },
      { file: path.join(dir, 'b.mp4'), join: 'auto' },
    ], 0);
    for (const result of [studio, mcp]) {
      const frames = await yavgs(filmPath(result));
      expect(frames).toHaveLength(384);
      expectIndices(frames, 0);
      expect(result.joins[0]).toMatchObject({ type: 'chain', chainFrameIndex: 191, detected: true });
    }
  }, 60_000);

  it('does not call an unrelated pair a chain', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(dir, 'a.mp4'),
    ]);
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1,hue=h=90',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(dir, 'b.mp4'),
    ]);
    const { studio, mcp } = await both(dir, 'unrelated', [
      { file: path.join(dir, 'a.mp4') },
      { file: path.join(dir, 'b.mp4') },
    ], 0);
    expect(studio.joins[0].type).not.toBe('chain');
    expect(mcp.joins[0].type).not.toBe('chain');
    expect(studio.joins[0].type).toBe('cut');
  }, 60_000);

  it('does not blend a chained pair when a crossfade is configured', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 48 });
    await indexClip(path.join(dir, 'b.mp4'), { start: 47, frames: 48 });
    const { studio } = await both(dir, 'nodissolve', [
      { file: path.join(dir, 'a.mp4'), chainFrameIndex: 47 },
      { file: path.join(dir, 'b.mp4'), join: 'chain' },
    ], 0.25);
    const frames = await yavgs(studio.outputPath);
    frames.forEach((value, index) => {
      expect(Math.abs(value - luma(index))).toBeLessThanOrEqual(0.5);
    });
  }, 60_000);

  it('crossfades six frames of two unrelated clips and keeps audio with the picture', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 96 });
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `nullsrc=s=320x180:r=24,geq=lum='if(eq(N\\,0)\\,235\\,40)':cb=128:cr=128`,
      '-f', 'lavfi', '-i', `aevalsrc=exprs='sin(2*PI*1000*t)*lt(t\\,0.02)':sample_rate=48000:duration=4`,
      '-frames:v', '96',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', path.join(dir, 'b.mp4'),
    ]);
    const { studio, mcp } = await both(dir, 'fade', [
      { file: path.join(dir, 'a.mp4') },
      { file: path.join(dir, 'b.mp4'), join: 'crossfade' },
    ], 0.25);
    for (const result of [studio, mcp]) {
      const file = filmPath(result);
      const frames = await yavgs(file);
      expect(Math.abs(frames.length - 186)).toBeLessThanOrEqual(1);
      const seam = frames.slice(88, 98);
      const impure = seam.filter((value, index) => Math.abs(value - luma(88 + index)) > 0.5);
      expect(impure.length).toBeGreaterThanOrEqual(5);
      expect(impure.length).toBeLessThanOrEqual(8);
      const audio = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', file,
      ]);
      const video = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', file,
      ]);
      expect(Math.abs(Number(audio.stdout) - Number(video.stdout))).toBeLessThanOrEqual(1 / 24 + 0.01);
      expect(result.filterGraph).toContain('xfade=');
      expect(result.filterGraph).toContain('acrossfade=');
    }
  }, 60_000);

  it('keeps flashes and beeps within one frame across ten short cuts', async () => {
    const dir = await withDir();
    dirs.push(dir);
    const clips = [];
    for (let index = 0; index < 10; index += 1) {
      const file = path.join(dir, `c${index}.mp4`);
      const frames = 36;
      const audioSeconds = (frames - 1) / 24;
      await exec('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `nullsrc=s=160x90:r=24,geq=lum='if(eq(N\\,12)\\,235\\,30)':cb=128:cr=128`,
        '-f', 'lavfi', '-i', `aevalsrc=exprs='sin(2*PI*1000*t)*between(t\\,0.5\\,0.51)':sample_rate=48000:duration=${audioSeconds}`,
        '-frames:v', String(frames),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', file,
      ]);
      clips.push({ file, join: 'cut' as const });
    }
    const { mcp } = await both(dir, 'drift', clips, 0);
    const frames = await yavgs(mcp.path);
    const flashes = frames.flatMap((value, index) => (value > 200 ? [index] : []));
    expect(flashes).toHaveLength(10);
    const audio = await exec('ffmpeg', [
      '-v', 'error', '-i', mcp.path, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const samples = new Float32Array(audio.stdout.buffer, audio.stdout.byteOffset, audio.stdout.length / 4);
    const onsets: number[] = [];
    let look = 0;
    while (onsets.length < 10 && look < samples.length) {
      if (Math.abs(samples[look]) > 0.2) {
        onsets.push(look / 48000);
        look += Math.floor(0.2 * 48000);
      } else {
        look += 1;
      }
    }
    expect(onsets).toHaveLength(10);
    flashes.forEach((frame, index) => {
      expect(Math.abs(onsets[index] - frame / 24)).toBeLessThanOrEqual(1 / 24 + 0.005);
    });
    const audioDuration = Number((await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', mcp.path,
    ])).stdout);
    const videoDuration = Number((await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', mcp.path,
    ])).stdout);
    expect(Math.abs(audioDuration - videoDuration)).toBeLessThanOrEqual(1 / 24 + 0.01);
  }, 90_000);

  it('keeps 24 fps footage at 24 fps with no fps filter', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 48 });
    await indexClip(path.join(dir, 'b.mp4'), { start: 48, frames: 48 });
    const { studio, mcp } = await both(dir, 'fps', [
      { file: path.join(dir, 'a.mp4') },
      { file: path.join(dir, 'b.mp4'), join: 'cut' },
    ], 0);
    for (const result of [studio, mcp]) {
      expect(result.filterGraph).not.toContain('fps=');
      expect(result.outputFps).toBe(24);
      const rate = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_frames', '-of', 'default=nw=1',
        filmPath(result),
      ]);
      expect(rate.stdout).toContain('24/1');
      const frames = await yavgs(filmPath(result));
      expect(frames).toHaveLength(96);
    }
  }, 60_000);

  it('conforms mixed fps, size, sar, and missing audio', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 24, width: 1280, height: 720 });
    await indexClip(path.join(dir, 'b.mp4'), {
      frames: 30, fps: 30, width: 848, height: 480, sar: '4/3', audioSeconds: 0.01, channels: 1, sampleRate: 44100,
    });
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=736x416:r=25:d=1',
      '-frames:v', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
      path.join(dir, 'c.mp4'),
    ]);
    const result = await assembleClips({
      clips: [
        { file: path.join(dir, 'a.mp4'), join: 'cut' },
        { file: path.join(dir, 'b.mp4'), join: 'cut' },
        { file: path.join(dir, 'c.mp4'), join: 'cut' },
      ],
      fadeDuration: 0,
    });
    const probe = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,width,height,sample_aspect_ratio,pix_fmt,r_frame_rate,sample_rate,channel_layout',
      '-of', 'json', result.path,
    ]);
    const streams = JSON.parse(probe.stdout).streams as Array<Record<string, string>>;
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    expect(video).toMatchObject({ width: 1280, height: 720, pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1' });
    expect(video?.r_frame_rate).toBe('24/1');
    expect(audio?.sample_rate).toBe('48000');
    expect(audio?.channel_layout).toMatch(/stereo/);
  }, 60_000);

  it('matches chain and cut frames on the 2018 ffmpeg and reports a missing xfade', async () => {
    const dir = await withDir();
    dirs.push(dir);
    await indexClip(path.join(dir, 'a.mp4'), { frames: 24, start: 0 });
    await indexClip(path.join(dir, 'b.mp4'), { frames: 24, start: 23 });
    await indexClip(path.join(dir, 'c.mp4'), { frames: 24, start: 200 });
    const clips = [
      { file: path.join(dir, 'a.mp4'), chainFrameIndex: 23 },
      { file: path.join(dir, 'b.mp4'), join: 'chain' as const },
      { file: path.join(dir, 'c.mp4'), join: 'cut' as const },
    ];
    const modern = await assembleClips({ clips, fadeDuration: 0 });
    process.env.FFMPEG_PATH = BUNDLED;
    process.env.FFPROBE_PATH = '/usr/bin/ffprobe';
    resetToolCache();
    const legacy = await assembleClips({ clips, fadeDuration: 0 });
    const legacyFrames = await yavgs(legacy.path);
    expect(legacyFrames.map((value) => Math.round(value))).toEqual(
      (await yavgs(modern.path)).map((value) => Math.round(value)),
    );
    const faded = await assembleFilm([
      { shotId: 'a', title: 'A', order: 1, filePath: path.join(dir, 'a.mp4') },
      { shotId: 'c', title: 'C', order: 2, filePath: path.join(dir, 'c.mp4'), join: 'crossfade' },
    ], dir, 'bundled-fade', { crossfadeSeconds: 0.25 });
    expect(faded.joins[0].applied === 'emulated' || (faded.joins[0].applied === 'cut' && faded.joins[0].reason === 'xfade-unavailable')).toBe(true);
    expect(faded.notice).toMatch(/xfade/i);
    await expect(assemblePlanned({
      clips: [{ file: path.join(dir, 'a.mp4') }],
      crossfadeSeconds: 0,
      outputPath: path.join(dir, 'broken.mp4'),
      outputSize: { width: Number.NaN, height: Number.NaN },
    })).rejects.toThrow(/Invalid|Option not found|Error initializing/);
  }, 60_000);

  it('probes frame geometry with ffmpeg when ffprobe is not installed', async () => {
    const dir = await withDir();
    dirs.push(dir);
    const file = path.join(dir, 'a.mp4');
    await indexClip(file, { frames: 24, width: 320, height: 180 });
    process.env.FFMPEG_PATH = BUNDLED;
    process.env.FFPROBE_PATH = '/nonexistent/ffprobe';
    process.env.THESHOW_NO_FFPROBE = '1';
    resetToolCache();
    const probe = await probeVideo(file);
    expect(probe.frameCount).toBe(24);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(180);
    expect(probe.fps).toBe(24);
  }, 30_000);

  it('extracts the true last frame from both composers', async () => {
    const dir = await withDir();
    dirs.push(dir);
    const file = path.join(dir, 'a.mp4');
    await indexClip(file, { frames: 193 });
    const studio = await extractStudioFrame(file, path.join(dir, 'studio.png'));
    const mcp = await extractMcpFrame({ file });
    expect(studio.frameIndex).toBe(192);
    expect(mcp.frameIndex).toBe(192);
    expect(mcp.framePts).toBeCloseTo(192 / 24, 5);
    for (const frame of [studio.path, mcp.path]) {
      const values = await yavgs(frame);
      expect(Math.abs(values[0] - luma(192))).toBeLessThanOrEqual(1.5);
    }
  }, 30_000);

  it('ignores an automatic pacing trim on a chained studio assemble', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'sandbox';
    const agent = request.agent(app);
    const register = await agent.post('/api/auth/register').send({
      name: 'Join Tester',
      email: `join-${Date.now()}@example.com`,
      password: 'Passw0rd!23',
    });
    expect(register.status).toBe(201);
    const csrf = register.body.csrfToken as string;
    const operations = [];
    for (const title of ['Shot 1', 'Shot 2']) {
      const generation = await agent.post('/api/generate-video').set('x-csrf-token', csrf).send({
        characters: [],
        scenes: [{ title, description: title }],
        camera: { aspectRatio: '16:9' },
      });
      expect(generation.status).toBe(200);
      operations.push(generation.body.operationName as string);
    }
    const chained = await agent.post('/api/assemble-film').set('x-csrf-token', csrf).send({
      crossfadeSeconds: 0.25,
      clips: [
        {
          shotId: 'shot-1',
          title: 'Shot 1',
          order: 1,
          operationName: operations[0],
          trimEndSeconds: 7.1,
          trimEndSource: 'auto',
          chainFrameIndex: 9999,
        },
        {
          shotId: 'shot-2',
          title: 'Shot 2',
          order: 2,
          operationName: operations[1],
          join: 'chain',
          chainedFromPrevious: true,
        },
      ],
    });
    expect(chained.status, JSON.stringify(chained.body)).toBe(200);
    expect(chained.body.joins[0].type).toBe('chain');
    expect(chained.body.joins[0].crossfadeFrames).toBe(0);
    const download = await agent.get(chained.body.downloadUrl);
    expect(download.status).toBe(200);
    const duration = Number((await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', chained.body.outputPath,
    ])).stdout);
    expect(duration).toBeGreaterThan(15.5);

    const broken = await agent.post('/api/assemble-film').set('x-csrf-token', csrf).send({
      crossfadeSeconds: 0.25,
      clips: [
        {
          shotId: 'shot-1',
          title: 'Shot 1',
          order: 1,
          operationName: operations[0],
          trimEndSeconds: 7.1,
          trimEndSource: 'user',
          chainFrameIndex: 9999,
        },
        {
          shotId: 'shot-2',
          title: 'Shot 2',
          order: 2,
          operationName: operations[1],
          join: 'chain',
          chainedFromPrevious: true,
        },
      ],
    });
    expect(broken.status).toBe(200);
    expect(broken.body.joins[0].label).toBe('Chain broken by trim');
    expect(broken.body.joins[0].type === 'cut' || broken.body.joins[0].type === 'crossfade').toBe(true);
  }, 60_000);
});

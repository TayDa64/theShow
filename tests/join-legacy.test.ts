/**
 * Legacy job files stay byte-identical on read. A killed assembly is finished
 * from the files on disk, with no model call.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JOBS_DIR, OUTPUT_DIR, assembleClips } from '../mcp/media';
import { createTheShowServer } from '../mcp/server';

const exec = promisify(execFile);
let client: Client;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toolText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return '';
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

async function filmsOnDisk(): Promise<number> {
  const names = await readdir(OUTPUT_DIR).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.mp4')).length;
}

async function colorClip(file: string, frames = 24): Promise<void> {
  await exec('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file,
  ]);
}

async function indexClip(file: string, start: number, frames: number): Promise<void> {
  await exec('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `nullsrc=s=160x90:r=24,geq=lum='16+mod((N+${start})*3\\,220)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=9',
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file,
  ]);
}

function stoppedJob(id: string, shots: unknown[], extra: Record<string, unknown> = {}): string {
  const { settings: settingsExtra, ...top } = extra;
  const settings = {
    aspectRatio: '16:9',
    resolution: '720p',
    model: 'grok-imagine-video-1.5',
    fadeDuration: 0,
    assemble: true,
    pin: 'start',
    ...(settingsExtra as Record<string, unknown> | undefined),
  };
  return JSON.stringify({
    id,
    startedAt: 10,
    state: 'stopped',
    shotCount: shots.length,
    completed: shots.length,
    estimateUsd: 0,
    spentUsd: 0,
    error: 'The server stopped while this film was rendering.',
    shots,
    settings,
    ...top,
  });
}

async function expectUntouched(original: string, reason?: RegExp): Promise<void> {
  const id = JSON.parse(original).id as string;
  const file = path.join(JOBS_DIR, `${id}.json`);
  await writeFile(file, original);
  const before = await filmsOnDisk();
  const checked = JSON.parse(toolText(await client.callTool({ name: 'check_sequence', arguments: { jobId: id } })));
  expect(checked.state).toBe('stopped');
  expect(checked.filmPath).toBeUndefined();
  expect(checked.assembleAvailable).toBe(true);
  if (reason) expect(checked.message).toMatch(reason);
  expect(sha(await readFile(file, 'utf8'))).toBe(sha(original));
  expect(await filmsOnDisk()).toBe(before);
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fresh = createTheShowServer();
  await fresh.connect(serverTransport);
  client = new Client({ name: 'join-legacy', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe('legacy jobs and local recovery', () => {
  it('does not rewrite a legacy job when it is listed, checked, or fed', async () => {
    const id = `seq_legacy_joins_${Date.now().toString(36)}`;
    const original = JSON.stringify({
      id,
      startedAt: 1,
      finishedAt: 2,
      state: 'completed',
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      filmPath: '/keep/legacy.mp4',
      shots: [{
        index: 1,
        title: 'Old',
        status: 'completed',
        localPath: '/keep/legacy.mp4',
        prompt: 'A lantern.',
        durationSeconds: 8,
        costUsd: 1,
      }],
      settings: {
        aspectRatio: '16:9',
        resolution: '720p',
        model: 'grok-imagine-video-1.5',
        fadeDuration: 0,
        assemble: true,
        pin: 'start',
      },
    });
    const file = path.join(JOBS_DIR, `${id}.json`);
    await writeFile(file, original);
    const before = sha(original);
    await client.callTool({ name: 'list_films', arguments: { includeUnfinished: true, limit: 50 } });
    await client.callTool({ name: 'check_sequence', arguments: { jobId: id } });
    await client.callTool({ name: 'production_feed', arguments: { limit: 50 } });
    const retry = toolText(await client.callTool({
      name: 'retry_shot',
      arguments: { jobId: id, shotIndex: 1 },
    }));
    expect(retry).toMatch(/confirm|price|estimate|cost/i);
    expect(sha(await readFile(file, 'utf8'))).toBe(before);
  });

  it('leaves a legacy stopped job byte-identical', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'legacy-stopped-'));
    const clip = path.join(dir, 'a.mp4');
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      clip,
    ]);
    const id = `seq_legacy_stopped_${Date.now().toString(36)}`;
    const original = JSON.stringify({
      id,
      startedAt: 10,
      state: 'stopped',
      shotCount: 1,
      completed: 1,
      estimateUsd: 0,
      spentUsd: 0,
      error: 'The server stopped while this film was rendering.',
      shots: [{
        index: 1,
        title: 'Old',
        status: 'completed',
        localPath: clip,
        prompt: 'A lantern.',
        durationSeconds: 1,
      }],
      settings: {
        aspectRatio: '16:9',
        resolution: '720p',
        model: 'grok-imagine-video-1.5',
        fadeDuration: 0,
        assemble: true,
        pin: 'start',
      },
    });
    const file = path.join(JOBS_DIR, `${id}.json`);
    await writeFile(file, original);
    const checked = JSON.parse(toolText(await client.callTool({ name: 'check_sequence', arguments: { jobId: id } })));
    expect(checked.state).toBe('stopped');
    expect(checked.filmPath).toBeUndefined();
    expect(checked.assembleAvailable).toBe(true);
    expect(checked.message).toMatch(/assemble_film/);
    expect(sha(await readFile(file, 'utf8'))).toBe(sha(original));
  });

  it.each([
    ['joins:null', { joins: null }],
    ['settings.outputFps:null', { settings: { outputFps: null } }],
    ['a single joinIn', { shot: { joinIn: 'chain' } }],
    ["chainFrameIndex:'999'", { shot: { chainFrameIndex: '999' } }],
  ])('leaves a forged stopped job byte-identical (%s)', async (_label, forged) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forged-stopped-'));
    const clip = path.join(dir, 'a.mp4');
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      clip,
    ]);
    const id = `seq_forged_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const shotExtra = 'shot' in forged ? forged.shot : {};
    const settingsExtra = 'settings' in forged ? forged.settings : {};
    const top: Record<string, unknown> = {};
    if ('joins' in forged) top.joins = forged.joins;
    const original = JSON.stringify({
      id,
      startedAt: 10,
      state: 'stopped',
      shotCount: 1,
      completed: 1,
      estimateUsd: 0,
      spentUsd: 0,
      error: 'The server stopped while this film was rendering.',
      shots: [{
        index: 1,
        title: 'Old',
        status: 'completed',
        localPath: clip,
        prompt: 'A lantern.',
        durationSeconds: 1,
        ...shotExtra,
      }],
      settings: {
        aspectRatio: '16:9',
        resolution: '720p',
        model: 'grok-imagine-video-1.5',
        fadeDuration: 0,
        assemble: true,
        pin: 'start',
        ...settingsExtra,
      },
      ...top,
    });
    const file = path.join(JOBS_DIR, `${id}.json`);
    await writeFile(file, original);
    const checked = JSON.parse(toolText(await client.callTool({ name: 'check_sequence', arguments: { jobId: id } })));
    expect(checked.state).toBe('stopped');
    expect(checked.filmPath).toBeUndefined();
    expect(checked.assembleAvailable).toBe(true);
    expect(sha(await readFile(file, 'utf8'))).toBe(sha(original));
  });

  it('rejects a 2-shot job whose join list has the wrong length', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'join-count-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file)));
    const id = `seq_join_count_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ], {
      joins: [{ type: 'cut' }, { type: 'cut' }],
    }));
  });

  it('rejects a 3-shot job whose join list is short one join', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'join-count3-'));
    const clips = ['a', 'b', 'c'].map((name) => path.join(dir, `${name}.mp4`));
    await Promise.all(clips.map((file) => colorClip(file, 8)));
    const id = `seq_join_count3_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, clips.map((file, index) => ({
      index: index + 1,
      title: `Shot ${index + 1}`,
      status: 'completed',
      localPath: file,
      prompt: 'A lantern.',
      durationSeconds: 1,
    })), {
      joins: [{ type: 'cut' }],
    }));
  });

  it('rejects a 2-shot job whose join type is unknown', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'join-type-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file)));
    const id = `seq_join_type_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ], {
      joins: [{ type: 'slide' }],
    }));
  });

  it('rejects a 2-shot job whose outputFps is not positive', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fps-zero-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file)));
    const id = `seq_fps_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ], {
      settings: { outputFps: 0 },
    }));
  });

  it('rejects a negative chainFramePts on an otherwise real chain', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pts-neg-'));
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    await indexClip(a, 0, 24);
    await indexClip(b, 23, 24);
    const id = `seq_pts_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      {
        index: 1, title: 'A', status: 'completed', localPath: a, prompt: 'A', durationSeconds: 1,
        chainFrameIndex: 23, chainFramePts: -1,
      },
      { index: 2, title: 'B', status: 'completed', localPath: b, prompt: 'B', durationSeconds: 1, joinIn: 'chain' },
    ]));
  });

  it('rejects a fractional chainFrameIndex', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'index-frac-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file)));
    const id = `seq_frac_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1, chainFrameIndex: 23.5 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ]));
  });

  it('rejects a negative chainFrameIndex', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'index-neg-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file)));
    const id = `seq_neg_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1, chainFrameIndex: -1 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ]));
  });

  it('rejects a chainFrameIndex past the last frame', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'index-range-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    await Promise.all(clips.map((file) => colorClip(file, 24)));
    const id = `seq_range_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      { index: 1, title: 'A', status: 'completed', localPath: clips[0], prompt: 'A', durationSeconds: 1, chainFrameIndex: 24 },
      { index: 2, title: 'B', status: 'completed', localPath: clips[1], prompt: 'B', durationSeconds: 1 },
    ]));
  });

  it('leaves an index-10 chain forgery byte-identical', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'index-10-'));
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    await indexClip(a, 0, 193);
    await indexClip(b, 192, 193);
    const id = `seq_index10_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      {
        index: 1, title: 'A', status: 'completed', localPath: a, prompt: 'A', durationSeconds: 8,
        chainFrameIndex: 10, chainFramePts: 10 / 24,
      },
      { index: 2, title: 'B', status: 'completed', localPath: b, prompt: 'B', durationSeconds: 8, joinIn: 'chain' },
    ]), /does not match the frame detected/);
  }, 60_000);

  it('leaves a mismatched chainFramePts byte-identical', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pts-mismatch-'));
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    await indexClip(a, 0, 193);
    await indexClip(b, 192, 193);
    const id = `seq_pts_mismatch_${Date.now().toString(36)}`;
    await expectUntouched(stoppedJob(id, [
      {
        index: 1, title: 'A', status: 'completed', localPath: a, prompt: 'A', durationSeconds: 8,
        chainFrameIndex: 192, chainFramePts: 0,
      },
      { index: 2, title: 'B', status: 'completed', localPath: b, prompt: 'B', durationSeconds: 8, joinIn: 'chain' },
    ]), /half a frame/);
  }, 60_000);

  it('finishes a killed assembly from the job file alone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'recover-'));
    const clips = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
    for (const [index, file] of clips.entries()) {
      const start = index === 0 ? 0 : 23;
      await exec('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `nullsrc=s=160x90:r=24,geq=lum='16+mod((N+${start})*3\\,220)':cb=128:cr=128`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        '-frames:v', '24', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
      ]);
    }
    const id = `seq_recover_${Date.now().toString(36)}`;
    const job = {
      id,
      startedAt: 1,
      state: 'stopped',
      shotCount: 2,
      completed: 2,
      estimateUsd: 0,
      spentUsd: 0,
      error: 'killed before assembly',
      shots: [
        {
          index: 1,
          title: 'A',
          status: 'completed',
          localPath: clips[0],
          framePath: path.join(dir, 'a-frame.png'),
          chainFrameIndex: 23,
          prompt: 'A',
          durationSeconds: 1,
        },
        {
          index: 2,
          title: 'B',
          status: 'completed',
          localPath: clips[1],
          openingFramePath: path.join(dir, 'a-frame.png'),
          joinIn: 'chain',
          prompt: 'B',
          durationSeconds: 1,
        },
      ],
      settings: {
        aspectRatio: '16:9',
        resolution: '720p',
        model: 'grok-imagine-video-1.5',
        fadeDuration: 0,
        assemble: true,
        pin: 'start',
      },
    };
    await writeFile(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(job));
    const direct = await assembleClips({
      clips: [
        { file: clips[0], chainFrameIndex: 23 },
        { file: clips[1], join: 'chain' },
      ],
      fadeDuration: 0,
    });
    const checked = JSON.parse(toolText(await client.callTool({ name: 'check_sequence', arguments: { jobId: id } })));
    expect(checked.state).toBe('completed');
    expect(checked.joins[0].type).toBe('chain');
    const recovered = await exec('ffmpeg', [
      '-hide_banner', '-i', checked.filmPath, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-',
    ]);
    const directFrames = await exec('ffmpeg', [
      '-hide_banner', '-i', direct.path, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-',
    ]);
    const read = (text: string) => text.split('\n').flatMap((line) => {
      const match = line.match(/YAVG=([0-9.]+)/);
      return match ? [Math.round(Number(match[1]))] : [];
    });
    expect(read(String(recovered.stdout))).toEqual(read(String(directFrames.stdout)));
  }, 60_000);

  it('finishes a genuine 193-frame chain from the job file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'genuine-385-'));
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    await indexClip(a, 0, 193);
    await indexClip(b, 192, 193);
    const id = `seq_genuine_${Date.now().toString(36)}`;
    const job = stoppedJob(id, [
      {
        index: 1, title: 'A', status: 'completed', localPath: a, prompt: 'A', durationSeconds: 8,
        chainFrameIndex: 192, chainFramePts: 192 / 24,
      },
      { index: 2, title: 'B', status: 'completed', localPath: b, prompt: 'B', durationSeconds: 8, joinIn: 'chain' },
    ]);
    await writeFile(path.join(JOBS_DIR, `${id}.json`), job);
    const checked = JSON.parse(toolText(await client.callTool({ name: 'check_sequence', arguments: { jobId: id } })));
    expect(checked.state).toBe('completed');
    expect(checked.error).toBeUndefined();
    expect(checked.joins[0]).toMatchObject({ type: 'chain', chainFrameIndex: 192 });
    const counted = await exec('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0',
      checked.filmPath,
    ]);
    expect(Number(counted.stdout.trim())).toBe(385);
  }, 60_000);
});

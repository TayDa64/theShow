/**
 * Legacy job files stay byte-identical on read. A killed assembly is finished
 * from the files on disk, with no model call.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JOBS_DIR, assembleClips } from '../mcp/media';
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
});

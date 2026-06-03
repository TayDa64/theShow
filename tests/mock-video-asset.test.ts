import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ensureMockVideoAsset } from '../src/lib/mockVideoAsset';

describe('mock video asset generation', () => {
  it('creates a valid local MP4 fallback clip', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyforge-mock-video-'));

    const videoPath = await ensureMockVideoAsset({
      cacheDir,
      operationName: 'mock-operation-test-clip',
      aspectRatio: '16:9',
      durationSeconds: 1,
    });

    const header = fs.readFileSync(videoPath);

    expect(fs.existsSync(videoPath)).toBe(true);
    expect(header.toString('ascii', 4, 8)).toBe('ftyp');
  });
});

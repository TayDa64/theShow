import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FADE_DURATION, assembleFilm, buildAssemblyFilterGraph, extractLastFrame } from '../src/lib/ffmpegComposer';

describe('ffmpeg composer', () => {
  it('builds a cascaded xfade graph with 0.5 second dissolves', () => {
    const graph = buildAssemblyFilterGraph([
      { durationSeconds: 8 },
      { durationSeconds: 8 },
      { durationSeconds: 8 },
    ]);

    expect(FADE_DURATION).toBe(0.5);
    expect(graph.filterComplex).toContain('xfade=transition=dissolve:duration=0.5:offset=7.5');
    expect(graph.filterComplex).toContain('xfade=transition=dissolve:duration=0.5:offset=15');
    expect(graph.filterComplex).toContain('acrossfade=d=0.5');
  });

  it('invokes ffmpeg with -sseof -0.1 when extracting the final frame', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-frame-'));
    const inputPath = path.join(tempDir, 'clip.mp4');
    fs.writeFileSync(inputPath, Buffer.from('clip'));

    await extractLastFrame(inputPath);

    const state = (globalThis as any).__ffmpegState.commands.at(-1);
    expect(state.inputOptions).toEqual(['-sseof', '-0.1']);
  });

  it('assembles film clips into a downloadable mp4 output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-assemble-'));
    const clips = [1, 2, 3].map((index) => {
      const filePath = path.join(tempDir, `clip-${index}.mp4`);
      fs.writeFileSync(filePath, Buffer.from(`clip-${index}`));
      return {
        shotId: `shot-${index}`,
        title: `Shot ${index}`,
        order: index,
        filePath,
        durationSeconds: 8,
      };
    });

    const result = await assembleFilm(clips, tempDir, 'assembled-film');
    expect(result.outputPath).toBe(path.join(tempDir, 'assembled-film.mp4'));
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });
});

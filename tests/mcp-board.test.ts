/**
 * Guards the stills-first board: the cheap checkpoint that runs before any
 * video is paid for.
 *
 * The three things that would make a board worse than useless, and each is
 * asserted here:
 *
 *  - spending past the caller's ceiling, because the estimate arrived too late
 *  - paying twice for a still that is already on disk after a partial run
 *  - returning shots whose frames do not actually meet at the cut, which is the
 *    only reason to board a film at all
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardFilm, findExistingStill, planBoardFrames, toRenderShots } from '../mcp/storyboard.ts';

const SHOTS = [
  { prompt: 'Wide empty street at dawn, lamplight still on.', title: 'Establishing', durationSeconds: 8 },
  { prompt: 'A lamplighter walks the street, pole over one shoulder.', title: 'Character intro', durationSeconds: 8 },
  { prompt: 'Close on his hands turning the wick; the flame catches.', title: 'Complication', durationSeconds: 6 },
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-board-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Stands in for generateGrokStill: writes a small file, bills two cents. */
function fakeStill() {
  return vi.fn(async (
    job: { prompt: string },
    opts: { outputDir: string; filename?: string },
  ) => {
    const file = path.join(opts.outputDir, `${opts.filename ?? `still-${Date.now()}`}.png`);
    fs.writeFileSync(file, `fake-still:${job.prompt.slice(0, 40)}`);
    return {
      imageUrl: `https://example.invalid/${path.basename(file)}`,
      localPath: file,
      mimeType: 'image/png',
      costUsd: 0.02,
      aspectRatioParam: 'aspect_ratio' as const,
    };
  });
}

describe('frame planning', () => {
  it('plans N+1 stills for N shots, because a boundary is one shared picture', () => {
    const frames = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9' });
    expect(frames).toHaveLength(SHOTS.length + 1);
    expect(frames[0].prompt).toContain('Opening frame of shot 1');
    expect(frames.at(-1)!.prompt).toContain('Closing frame of shot 3');
    // The middle frames are explicitly both things at once: that is the join.
    expect(frames[1].prompt).toContain('last frame of shot 1 and the first frame of shot 2');
  });

  it('folds the look into every still prompt so the board matches the film', () => {
    const frames = planBoardFrames({
      shots: SHOTS,
      aspectRatio: '9:16',
      look: 'Photoreal cinematic, sodium lamplight, 1890s London.',
    });
    for (const frame of frames) {
      expect(frame.prompt).toContain('Photoreal cinematic, sodium lamplight, 1890s London.');
      expect(frame.prompt).toContain('9:16');
    }
  });

  it('names each frame from its own prompt, so the same frame is found again', () => {
    const a = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9' });
    const b = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9' });
    expect(a.map((f) => f.stem)).toEqual(b.map((f) => f.stem));
    // A different prompt is a different frame, and must not collide with it.
    const changed = planBoardFrames({
      shots: [{ ...SHOTS[0], prompt: 'A different street.' }, SHOTS[1], SHOTS[2]],
      aspectRatio: '16:9',
    });
    expect(changed[0].stem).not.toBe(a[0].stem);
  });
});

describe('the board estimate gate', () => {
  it('reports the cost before spending anything, and renders nothing', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: SHOTS, aspectRatio: '16:9' },
      { generateStill, outputDir: dir },
    );

    expect(generateStill).not.toHaveBeenCalled();
    expect(board.action).toBe('estimate-only');
    expect(board.willSpend).toBe(false);
    expect(board.estimate.totalStills).toBe(4);
    expect(board.estimate.newStills).toBe(4);
    expect(board.estimate.estimatedUsd).toBeCloseTo(0.08, 6);
    expect(board.estimate.isEstimate).toBe(true);
    // Four stills for three shots, and the basis says why.
    expect(board.estimate.basis).toContain('4 frames for 3 shots');
  });

  it('refuses to spend when the estimate is over maxCostUsd', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: SHOTS, maxCostUsd: 0.05, confirm: true },
      { generateStill, outputDir: dir },
    );

    // confirm: true, over budget, and still not a single call was made.
    expect(generateStill).not.toHaveBeenCalled();
    expect(board.action).toBe('over-budget');
    expect(board.willSpend).toBe(false);
    expect(board.estimate.spentUsd).toBe(0);
    expect(board.error).toContain('over the $0.05 limit');
    expect(board.error).toContain('Nothing was spent');
  });

  it('goes ahead when the estimate is inside maxCostUsd', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: SHOTS, maxCostUsd: 0.08, confirm: true },
      { generateStill, outputDir: dir },
    );

    expect(board.action).toBe('boarded');
    expect(generateStill).toHaveBeenCalledTimes(4);
    expect(board.estimate.spentUsd).toBeCloseTo(0.08, 6);
  });

  it('boards nothing at all for an empty shot list', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: [], confirm: true },
      { generateStill, outputDir: dir },
    );
    expect(generateStill).not.toHaveBeenCalled();
    expect(board.shots).toHaveLength(0);
    expect(board.error).toBeTruthy();
  });
});

describe('re-running a board', () => {
  it('reuses stills already on disk instead of paying twice', async () => {
    const first = fakeStill();
    const initial = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: first, outputDir: dir },
    );
    expect(first).toHaveBeenCalledTimes(4);
    expect(initial.action).toBe('boarded');

    // Second run: everything is on disk, so nothing is bought.
    const second = fakeStill();
    const repeat = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: second, outputDir: dir },
    );

    expect(second).not.toHaveBeenCalled();
    expect(repeat.action).toBe('boarded');
    expect(repeat.estimate.newStills).toBe(0);
    expect(repeat.estimate.reusedStills).toBe(4);
    expect(repeat.estimate.estimatedUsd).toBe(0);
    expect(repeat.estimate.spentUsd).toBe(0);
    expect(repeat.shots.map((s) => s.firstFrameUrl)).toEqual(
      initial.shots.map((s) => s.firstFrameUrl),
    );
  });

  it('buys only the frames a partial board is missing', async () => {
    const first = fakeStill();
    const initial = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: first, outputDir: dir },
    );

    // Lose one middle frame, as an interrupted run would.
    fs.rmSync(initial.frames[2].path!, { force: true });

    const second = fakeStill();
    const resumed = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: second, outputDir: dir },
    );

    expect(second).toHaveBeenCalledTimes(1);
    expect(resumed.estimate.newStills).toBe(1);
    expect(resumed.estimate.reusedStills).toBe(3);
    expect(resumed.estimate.spentUsd).toBeCloseTo(0.02, 6);
    expect(resumed.action).toBe('boarded');
  });

  it('finds a still under whichever extension it was saved with', async () => {
    const file = path.join(dir, 'board-abc123.jpg');
    fs.writeFileSync(file, 'bytes');
    expect(await findExistingStill(dir, 'board-abc123')).toBe(file);
    expect(await findExistingStill(dir, 'board-missing')).toBeUndefined();
  });

  it('reports a partial board rather than handing over unbookended shots', async () => {
    let calls = 0;
    const flaky = vi.fn(async (
      job: { prompt: string },
      opts: { outputDir: string; filename?: string },
    ) => {
      calls += 1;
      if (calls === 3) return { error: 'image route answered 500' } as any;
      const file = path.join(opts.outputDir, `${opts.filename}.png`);
      fs.writeFileSync(file, 'fake');
      return { localPath: file, costUsd: 0.02 };
    });

    const board = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: flaky, outputDir: dir },
    );

    expect(board.action).toBe('partial');
    expect(board.error).toContain('Frames missing for shots 2');
    // Shots either side of the missing frame cannot be pinned to it, so they are
    // withheld: a shot list with a hole in it renders a film with a pop in it.
    expect(board.shots).toHaveLength(0);
    expect(board.next).toContain('Do not render video from a partial board');
  });
});

describe('the boarded film cuts on shared frames', () => {
  it('makes shot N\u2019s last frame the same file as shot N+1\u2019s first frame', async () => {
    const board = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: fakeStill(), outputDir: dir },
    );

    expect(board.shots).toHaveLength(3);
    for (let i = 0; i < board.shots.length - 1; i++) {
      expect(board.shots[i].lastFrameUrl).toBe(board.shots[i + 1].firstFrameUrl);
      expect(board.shots[i].lastFrameIndex).toBe(board.shots[i + 1].firstFrameIndex);
    }
    // The first frame of the film is not anyone's last frame, and vice versa.
    expect(board.shots[0].firstFrameUrl).not.toBe(board.shots[0].lastFrameUrl);
    expect(new Set(board.shots.map((s) => s.lastFrameUrl)).size).toBe(3);
  });

  it('hands back shots in the exact shape render_sequence takes', async () => {
    const board = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill: fakeStill(), outputDir: dir },
    );
    const shots = toRenderShots(board);

    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(Object.keys(shot).sort()).toEqual(
        ['durationSeconds', 'firstFrameUrl', 'lastFrameUrl', 'prompt', 'title'],
      );
      expect(fs.existsSync(shot.firstFrameUrl)).toBe(true);
      expect(fs.existsSync(shot.lastFrameUrl)).toBe(true);
    }
    // Prompts and durations survive the trip, so the board and the render tell
    // the same story.
    expect(shots.map((s) => s.prompt)).toEqual(SHOTS.map((s) => s.prompt));
    expect(shots.map((s) => s.durationSeconds)).toEqual([8, 8, 6]);
  });

  it('accepts plan_storyboard output unchanged, where the beat is called action', async () => {
    const fromPlan = [
      { title: 'Establishing', action: 'A wide empty street at dawn.', durationSeconds: 8 },
      { title: 'Climax', action: 'The lamp goes out.', durationSeconds: 8 },
    ];
    const board = await boardFilm(
      { shots: fromPlan, confirm: true },
      { generateStill: fakeStill(), outputDir: dir },
    );

    expect(board.action).toBe('boarded');
    expect(board.shots[0].prompt).toBe('A wide empty street at dawn.');
    expect(board.shots[0].lastFrameUrl).toBe(board.shots[1].firstFrameUrl);
  });
});

describe('the board holds the cast', () => {
  it('seeds each still with the frame before it, so a face cannot change across a boundary', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill, outputDir: dir, referenceImageUrls: ['/portraits/lamplighter.jpg'] },
    );

    expect(board.action).toBe('boarded');
    const calls = generateStill.mock.calls as unknown as [
      { referenceImageUrls?: string[] },
      { outputDir: string; filename?: string },
    ][];
    expect(calls).toHaveLength(SHOTS.length + 1);

    // Frame 0 has nothing before it, so only the portrait seeds it.
    expect(calls[0][0].referenceImageUrls).toEqual(['/portraits/lamplighter.jpg']);

    // Every later frame carries the portrait AND the frame it follows. This is
    // the fix for a measured failure: an unchained three-shot board opened on an
    // old bearded lamplighter and cut to a different man in a flat cap.
    for (let i = 1; i < calls.length; i += 1) {
      const refs = calls[i][0].referenceImageUrls ?? [];
      expect(refs[0]).toBe('/portraits/lamplighter.jpg');
      expect(refs).toHaveLength(2);
      expect(refs[1]).toBe(board.frames[i - 1].path);
    }
  });

  it('still chains when no portraits were supplied', async () => {
    const generateStill = fakeStill();
    const board = await boardFilm(
      { shots: SHOTS, confirm: true },
      { generateStill, outputDir: dir },
    );
    const calls = generateStill.mock.calls as unknown as [{ referenceImageUrls?: string[] }][];

    // The opening frame is unseeded, which is correct: there is nothing yet.
    expect(calls[0][0].referenceImageUrls).toBeUndefined();
    expect(calls[1][0].referenceImageUrls).toEqual([board.frames[0].path]);
  });
});

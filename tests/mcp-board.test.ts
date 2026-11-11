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
    // The middle frame is written as the incoming shot's opening, with the
    // outgoing shot travelling to meet it. Describing it as both shots at once
    // made the model average them, which put a compromise medium where a
    // close-up was planned: measured, the face came out 0.101 of the frame wide
    // against the hero's 0.101, and the close-up never happened.
    expect(frames[1].prompt).toContain('The opening frame of shot 2, which is also the closing frame of shot 1');
    expect(frames[1].prompt).toContain('travels in to arrive at this picture');
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

  it('boards a midpoint still when a shot asks for a middle keyframe', async () => {
    const board = await boardFilm(
      {
        shots: [
          { prompt: 'Tay stands by the door.', durationSeconds: 8 },
          { prompt: 'Tay unbuttons and removes his coat.', durationSeconds: 8, middleKeyframe: true },
        ],
        confirm: true,
      },
      { generateStill: fakeStill(), outputDir: dir },
    );

    expect(board.frames).toHaveLength(4);
    expect(board.shots[1].middleFrameUrl).toBeDefined();
    expect(board.shots[1].firstFrameUrl).toBe(board.shots[0].lastFrameUrl);
    expect(board.shots[1].middleFrameUrl).not.toBe(board.shots[1].firstFrameUrl);
    expect(board.shots[1].middleFrameUrl).not.toBe(board.shots[1].lastFrameUrl);
    expect(board.shots[1].middleFrameIndex).toBeGreaterThan(board.shots[1].firstFrameIndex);
    expect(board.shots[1].middleFrameIndex).toBeLessThan(board.shots[1].lastFrameIndex);
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

describe('holding the cast', () => {
  it('repeats the cast verbatim at the head of every still prompt', () => {
    // A measured three-shot board put a bare-headed man in frame 0, a flat cap
    // in frame 1 and a top hat in frame 3, even with each still chained from
    // the one before it, because a reference image is a loose hint to the
    // stills endpoint. Repeating the cast in words is what actually holds a
    // face, so it must be in every prompt, not just the first.
    const cast = 'One man only: grey beard, dark flat cap, black double-breasted coat, brass-tipped pole';
    const frames = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', cast });
    expect(frames).toHaveLength(SHOTS.length + 1);
    for (const frame of frames) {
      expect(frame.prompt).toContain(cast);
    }
  });

  it('puts the cast ahead of the look so the scene cannot overrule it', () => {
    const cast = 'One man only: grey beard, dark flat cap';
    const look = 'Victorian London at night, wet cobblestones';
    const frames = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', cast, look });
    for (const frame of frames) {
      expect(frame.prompt.indexOf(cast)).toBeLessThan(frame.prompt.indexOf(look));
    }
  });

  it('gives every frame a distinct stem once a cast is set', () => {
    const frames = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', cast: 'One man, grey beard' });
    const stems = new Set(frames.map((frame) => frame.stem));
    expect(stems.size).toBe(frames.length);
  });

  it('leaves prompts unchanged when no cast is supplied', () => {
    const without = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9' });
    for (const frame of without) {
      expect(frame.prompt).not.toContain('THE CAST');
    }
  });
});

describe('editing from a location photo', () => {
  /**
   * The measured bug: on `/v1/images/generations` a reference is a hint the
   * prompt can overrule, so a five-frame board of one office redrew the skyline
   * every time. Editing from the location photo instead keeps the room. These
   * tests hold that routing, because a silent regression here looks like good
   * stills right up until the film is cut.
   */
  it('passes the base image and drops the chain when a base is given', async () => {
    const generateStill = fakeStill();
    await boardFilm(
      { shots: SHOTS, aspectRatio: '16:9', confirm: true },
      { outputDir: dir, baseImageUrl: '/refs/office.jpg', generateStill },
    );

    const jobs = generateStill.mock.calls.map(([job]) => job as { baseImageUrl?: string; referenceImageUrls?: string[] });
    expect(jobs).toHaveLength(SHOTS.length + 1);
    for (const job of jobs) {
      expect(job.baseImageUrl).toBe('/refs/office.jpg');
      // No chaining: chained frames agreed on the skyline at a mean 0.36 versus
      // 0.52 for frames edited from the base, so the chain is strictly worse.
      expect(job.referenceImageUrls ?? []).toHaveLength(0);
    }
  });

  it('still chains when no base is given', async () => {
    const generateStill = fakeStill();
    await boardFilm(
      { shots: SHOTS, aspectRatio: '16:9', confirm: true },
      { outputDir: dir, generateStill },
    );
    const jobs = generateStill.mock.calls.map(([job]) => job as { baseImageUrl?: string; referenceImageUrls?: string[] });
    expect(jobs[0].referenceImageUrls ?? []).toHaveLength(0);
    expect(jobs[1].referenceImageUrls).toHaveLength(1);
  });

  it('changes the frame stems when the base changes, so stale frames are not reused', () => {
    const a = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', baseImageUrl: '/refs/a.jpg' });
    const b = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', baseImageUrl: '/refs/b.jpg' });
    const none = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9' });
    expect(a.map((f) => f.stem)).not.toEqual(b.map((f) => f.stem));
    expect(a.map((f) => f.stem)).not.toEqual(none.map((f) => f.stem));
  });
});

describe('the picture outranks the prompt', () => {
  /**
   * Measured: a board whose cast line named a navy blazer while the reference
   * photo showed a tan sherpa coat swapped the outer layer in three of five
   * frames, because the text argued with the picture. Once the prompt said to
   * preserve what the photo shows, the same board held the coat in all five and
   * garment agreement rose from a mean 0.51 to 0.64.
   */
  it('tells the model to preserve the reference, not re-imagine it', () => {
    const frames = planBoardFrames({
      shots: SHOTS,
      aspectRatio: '16:9',
      cast: 'bald man, black beard, striped shirt, tan sherpa coat',
      baseImageUrl: '/refs/office.jpg',
    });
    for (const frame of frames) {
      expect(frame.prompt).toContain('taken from the reference picture');
      expect(frame.prompt).toContain('ground truth');
      expect(frame.prompt).toContain("exactly as the reference picture shows them");
      expect(frame.prompt).toContain('never restyle them');
    }
  });

  it('leaves a shot free to ask for a named wardrobe change', () => {
    const frames = planBoardFrames({
      shots: [{ prompt: 'He has taken the coat off, now wearing just the striped shirt.' }],
      aspectRatio: '16:9',
      cast: 'bald man, black beard',
      baseImageUrl: '/refs/office.jpg',
    });
    // The change is permitted, and said out loud, rather than silently reverted.
    expect(frames[0].prompt).toContain('asks for the clothing change it names');
    // The blanket "keep the clothing" instruction must be absent, or the shot
    // would be arguing with itself.
    expect(frames[0].prompt).not.toContain('never restyle them');
  });

  it('does not add picture rules when there is no picture', () => {
    const frames = planBoardFrames({ shots: SHOTS, aspectRatio: '16:9', cast: 'bald man' });
    for (const frame of frames) {
      expect(frame.prompt).not.toContain('ground truth');
    }
  });
});

describe('the outer garment survives the board', () => {
  /**
   * The failure this guards, and the honest state of the guard.
   *
   * A still that loses the coat's sleeves pins the end of one shot and the start
   * of the next, so the clip entering it interpolates into a costume change and
   * the film appears to ignore its own prompt. The cause was wording, and the
   * fix is in mcp/cast.ts: the cast line no longer names garments when a picture
   * is attached, so there is nothing for the model to build a second layer out
   * of.
   *
   * What is NOT here is a pixel check for a substituted garment. Two were built
   * and both were pulled:
   *
   *  - Fixed arm-band columns (13-29%, 71-87% of width) work only when the
   *    subject fills the frame like the portrait does. On a real board the man
   *    stands behind a desk occupying a third of the picture, so the band landed
   *    on furniture: it abstained on every frame of a shipped board, silently.
   *  - Anchoring the band to a detected face fixes that and separates cleanly
   *    (bad frames 0.144 and 0.262, good frames 0.391 and up, over 33 stills),
   *    but it needs a face detector. The plugin ships no OpenCV and no model
   *    files, and ffmpeg cannot find a head.
   *
   * Colour alone does not separate either: measured, a tan office wall scores
   * higher on the coat's hue than the coat does. So the guard is the prompt
   * wording, which is testable, and the pixel verdict belongs to the person
   * looking at the board - which is why board_film renders stills before it
   * renders video.
   */
  it('never names a garment in the prompt when a picture is attached', async () => {
    const generateStill = fakeStill();
    const cast =
      'Tay: bald head, full black beard with grey flecks at the chin, warm medium-brown skin, ' +
      'blue and white vertical-striped button-down shirt under a tan sherpa-collar jacket ' +
      'with a dark navy blazer beneath it';
    const board2 = await boardFilm(
      { shots: SHOTS, aspectRatio: '16:9', confirm: true, cast },
      { outputDir: dir, baseImageUrl: '/refs/office.jpg', generateStill },
    );
    for (const frame of board2.frames) {
      const prompt = String(frame.prompt);
      expect(prompt).not.toMatch(/blazer/i);
      expect(prompt).not.toMatch(/sherpa/i);
      // The identity half survives, because that is what a face can be checked against.
      expect(prompt).toMatch(/bald head/);
    }
  });
});

describe('a changed hero frame invalidates the shots bought from it', () => {
  /**
   * Found by running a proof board twice. Every shot frame is edited from the
   * HERO frame, not from the location photo the caller passed - so folding only
   * the location into the frame's file name lets a second run find the first
   * run's pictures and report them as "already on disk and free" while handing
   * back stills built against a hero that no longer exists.
   */
  it('names the frames after the hero, not the location photo', () => {
    const location = '/refs/office.jpg';
    const withHero = planBoardFrames({
      shots: SHOTS,
      aspectRatio: '16:9',
      baseImageUrl: location,
      baseFingerprint: 'board-hero-aaaa',
    });
    const otherHero = planBoardFrames({
      shots: SHOTS,
      aspectRatio: '16:9',
      baseImageUrl: location,
      baseFingerprint: 'board-hero-bbbb',
    });
    expect(withHero.map((f) => f.stem)).not.toEqual(otherHero.map((f) => f.stem));
    // Same hero, same stems: a genuine re-run must still be free.
    const again = planBoardFrames({
      shots: SHOTS,
      aspectRatio: '16:9',
      baseImageUrl: location,
      baseFingerprint: 'board-hero-aaaa',
    });
    expect(again.map((f) => f.stem)).toEqual(withHero.map((f) => f.stem));
  });
});

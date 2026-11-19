import { describe, expect, it } from 'vitest';
import {
  STUDIO_CROSSFADE_SECONDS,
  chooseOutputFps,
  chooseOutputSize,
  exclusiveFrameAt,
  planJoins,
  timelineJoinPresentation,
} from '../src/lib/joinPlan';

describe('join plan', () => {
  it('keeps the outgoing chain frame and drops the incoming frame 0', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: STUDIO_CROSSFADE_SECONDS,
      xfadeAvailable: true,
      clips: [
        { frameCount: 193, fps: 24, chainFrameIndex: 192, trimEndFrame: 171, trimEndSource: 'auto' },
        { frameCount: 193, fps: 24, join: 'chain', chainedFromPrevious: true },
      ],
    });
    expect(plan.segments[0]).toMatchObject({ startFrame: 0, endFrame: 193, frameCount: 193 });
    expect(plan.segments[1]).toMatchObject({ startFrame: 1, endFrame: 193, frameCount: 192 });
    expect(plan.totalFrames).toBe(385);
    expect(plan.joins[0]).toMatchObject({
      type: 'chain',
      applied: 'chain',
      chainFrameIndex: 192,
      crossfadeFrames: 0,
    });
    expect(plan.joins[0].label).toBe('Exact frame join (chained)');
  });

  it('uses a detected legacy chain frame and ignores an automatic trim', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0,
      xfadeAvailable: false,
      clips: [
        { frameCount: 193, fps: 24, trimEndFrame: exclusiveFrameAt(7.1, 24), trimEndSource: 'auto' },
        { frameCount: 193, fps: 24, join: 'auto', detectedChainFrame: 191 },
      ],
    });
    expect(exclusiveFrameAt(7.1, 24)).toBe(171);
    expect(plan.segments[0].endFrame).toBe(192);
    expect(plan.segments[1].startFrame).toBe(1);
    expect(plan.totalFrames).toBe(191 + 193);
    expect(plan.joins[0]).toMatchObject({ type: 'chain', chainFrameIndex: 191, detected: true });
  });

  it('does not invent a chain when nothing matches', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0,
      xfadeAvailable: true,
      clips: [
        { frameCount: 96, fps: 24 },
        { frameCount: 96, fps: 24, join: 'auto' },
      ],
    });
    expect(plan.joins[0].type).toBe('cut');
    expect(plan.totalFrames).toBe(192);
  });

  it('does not dissolve a chain when a crossfade is configured', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0.25,
      xfadeAvailable: true,
      clips: [
        { frameCount: 193, fps: 24, chainFrameIndex: 192 },
        { frameCount: 193, fps: 24, join: 'chain' },
      ],
    });
    expect(plan.joins[0].crossfadeFrames).toBe(0);
    expect(plan.joins[0].applied).toBe('chain');
  });

  it('places a 6-frame crossfade on unrelated 4 second clips', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0.25,
      xfadeAvailable: true,
      clips: [
        { frameCount: 96, fps: 24 },
        { frameCount: 96, fps: 24, join: 'auto' },
      ],
    });
    expect(plan.joins[0]).toMatchObject({ type: 'crossfade', applied: 'crossfade', crossfadeFrames: 6, offsetFrames: 90 });
    expect(plan.totalFrames).toBe(186);
  });

  it('keeps chain, crossfade, and cut offsets from drifting', () => {
    const clip = (extra: Partial<Parameters<typeof planJoins>[0]['clips'][number]> = {}) => ({
      frameCount: 193,
      fps: 24,
      ...extra,
    });
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0.25,
      xfadeAvailable: true,
      clips: [
        clip({ chainFrameIndex: 192 }),
        clip({ join: 'chain' }),
        clip({ join: 'crossfade' }),
        clip({ join: 'cut', chainFrameIndex: 192 }),
        clip({ join: 'chain' }),
      ],
    });
    expect(plan.joins.map((join) => join.type)).toEqual(['chain', 'crossfade', 'cut', 'chain']);
    expect(plan.totalFrames).toBe(193 + 192 + 193 + 193 + 192 - 6);
    expect(plan.joins[1].offsetFrames).toBe(193 + 192 - 6);
    expect(plan.joins[1].crossfadeFrames).toBe(6);
  });

  it('turns a user trim into a broken chain and reports a missing xfade', () => {
    const plan = planJoins({
      outputFps: 24,
      crossfadeSeconds: 0.25,
      xfadeAvailable: false,
      clips: [
        { frameCount: 193, fps: 24, chainFrameIndex: 192, trimEndFrame: 120, trimEndSource: 'user' },
        { frameCount: 193, fps: 24, join: 'chain' },
      ],
    });
    expect(plan.joins[0].type).toBe('crossfade');
    expect(plan.joins[0].applied).toBe('emulated');
    expect(plan.joins[0].reason).toBe('chain-broken-by-trim');
    expect(plan.joins[0].label).toBe('Chain broken by trim');
    expect(plan.segments[0].endFrame).toBe(120);
  });

  it('picks the most common fps and the first clip size unless a project size is set', () => {
    expect(chooseOutputFps([24, 30, 24])).toBe(24);
    expect(chooseOutputFps([30, 24, 25])).toBe(30);
    expect(chooseOutputSize({ first: { width: 1280, height: 720 } })).toEqual({ width: 1280, height: 720 });
    expect(chooseOutputSize({
      first: { width: 1280, height: 720 },
      project: { width: 1920, height: 1080 },
    })).toEqual({ width: 1920, height: 1080 });
  });

  it('names timeline joins for screen readers', () => {
    expect(timelineJoinPresentation({
      index: 0,
      chained: true,
      crossfadeSeconds: 0.25,
    }).accessibleName).toBe('Join 1 → 2: exact frame join (chained)');
    expect(timelineJoinPresentation({
      index: 2,
      chained: true,
      trimEndSource: 'user',
      crossfadeSeconds: 0.25,
    }).label).toBe('Chain broken by trim');
    expect(timelineJoinPresentation({
      index: 1,
      chained: false,
      join: 'cut',
      crossfadeSeconds: 0.25,
    }).accessibleName).toBe('Join 2 → 3: cut');
  });
});

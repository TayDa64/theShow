import { describe, expect, it } from 'vitest';
import { buildProjectTimelineManifest, normalizeScene, syncSceneTimeline } from '../src/utils/storyforge';

describe('timeline manifest compiler', () => {
  it('preserves manual edit decisions while marking changed source context dirty', () => {
    const scene = normalizeScene({
      id: 'scene-1',
      title: 'Act I',
      description: 'A tense exchange in the corridor.',
      lighting: 'cyberpunk-dusk',
      activeBackgroundImageId: 'bg-1',
      dialogues: [
        {
          id: 'dialogue-1',
          characterId: 'character-1',
          sentiment: 'tense',
          text: 'We need to keep talking long enough for the pacing engine to split this into a more cinematic timeline beat.',
        },
      ],
      storyboardShots: [
        {
          id: 'shot-1',
          shotNumber: 1,
          title: 'Opening exchange',
          shotType: 'medium-shot',
          durationSeconds: 8,
          composition: 'Keep both actors in the same tension line.',
          action: 'Hold on the reaction after the warning lands.',
          dialogueLineIds: ['dialogue-1'],
          dialogueExcerpt: '',
          continuityNotes: 'Maintain the corridor background and wardrobe.',
          generatedClips: [
            {
              id: 'generated-1',
              operationName: 'mock-operation-1',
              clipUrl: '/api/video-download?operationName=mock-operation-1',
              durationSeconds: 8,
              createdAt: '2026-01-01T00:00:00.000Z',
              resolvedSeed: 42,
            },
          ],
          activeGeneratedClipId: 'generated-1',
        },
      ],
      timelineClips: [
        {
          id: 'timeline-1',
          sceneId: 'scene-1',
          shotId: 'shot-1',
          order: 1,
          title: 'Opening exchange',
          selectedSourceClipId: 'generated-1',
          includeInCut: false,
          useFullSource: false,
          preferredDurationSeconds: 5,
          recommendedDurationSeconds: 5,
          sourceDurationSeconds: 8,
          trimStartSeconds: 1,
          trimEndSeconds: 4.5,
          playbackDurationSeconds: 3.5,
          backgroundStateId: 'bg-1',
          continuityGroupId: 'scene-1::bg-1',
          holdBackground: true,
          dialogueLineIds: ['dialogue-1'],
          dialogueExcerpt: '',
          sourceHash: 'stale-source-hash',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const syncedScene = syncSceneTimeline(scene);
    const [timelineClip] = syncedScene.timelineClips || [];

    expect(timelineClip.includeInCut).toBe(false);
    expect(timelineClip.trimStartSeconds).toBe(1);
    expect(timelineClip.trimEndSeconds).toBe(4.5);
    expect(timelineClip.recommendedDurationSeconds).toBeGreaterThan(8);
    expect(timelineClip.dirty).toBe(true);
    expect(timelineClip.dirtyReason).toContain('changed');

    const manifest = buildProjectTimelineManifest([syncedScene]);
    expect(manifest.totalClipCount).toBe(1);
    expect(manifest.includedClipCount).toBe(0);
    expect(manifest.readyClipCount).toBe(0);
    expect(manifest.clips[0].operationName).toBe('mock-operation-1');
  });
});

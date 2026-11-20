/**
 * Join labels on the timeline and the export panel.
 * WCAG 2.2 AA at 1280 and 375. Labels are text, and each has an accessible name.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../playwright/hermetic.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const characters = [{
  id: 'char-1',
  name: 'Kaelen Thorne',
  role: 'Lead',
  thumbnail: null,
  properties: {
    age: 28,
    build: 'average',
    gender: 'male',
    hairColor: 'Ash Brown',
    hairStyle: 'Messy undercut',
    eyeColor: 'Hazel',
    outfit: 'Tactical coat',
    temperament: 'Stoic',
    backstory: 'A courier turned operative.',
    stylePreset: 'cinematic-actor',
  },
  updatedAt: '2026-06-10T10:00:00.000Z',
}];

function shot(index: number, transition: 'none' | 'previous-shot') {
  return {
    id: `shot-${index}`,
    shotNumber: index,
    title: `Beat ${index}`,
    shotType: 'medium-shot',
    durationSeconds: 8,
    composition: 'Hold the line.',
    action: 'Keep the camera moving.',
    dialogueLineIds: [] as string[],
    continuityNotes: 'Same wardrobe.',
    transitionInMode: transition,
    generatedClips: [{
      id: `generated-${index}`,
      operationName: `mock-operation-join-${index}`,
      clipUrl: '',
      durationSeconds: 8,
      createdAt: '2026-06-10T10:00:00.000Z',
    }],
    activeGeneratedClipId: `generated-${index}`,
  };
}

function clip(index: number, extra: Record<string, unknown> = {}) {
  return {
    id: `timeline-${index}`,
    sceneId: 'scene-joins',
    shotId: `shot-${index}`,
    order: index,
    title: `Beat ${index}`,
    selectedSourceClipId: `generated-${index}`,
    includeInCut: true,
    useFullSource: false,
    preferredDurationSeconds: 8,
    recommendedDurationSeconds: 8,
    sourceDurationSeconds: 8,
    trimStartSeconds: 0,
    trimEndSeconds: 8,
    playbackDurationSeconds: 8,
    backgroundStateId: 'bg-joins',
    continuityGroupId: 'scene-joins::bg-joins',
    holdBackground: true,
    dialogueLineIds: [] as string[],
    dialogueExcerpt: '',
    sourceHash: 'join-source',
    updatedAt: '2026-06-10T10:00:00.000Z',
    ...extra,
  };
}

const scenes = [{
  id: 'scene-joins',
  title: 'Join reel',
  description: 'Four different joins.',
  lighting: 'cyberpunk-dusk',
  atmosphereNotes: 'Keep the room.',
  activeBackgroundImageId: 'bg-joins',
  dialogues: [],
  storyboardShots: [
    shot(1, 'none'),
    shot(2, 'previous-shot'),
    shot(3, 'none'),
    shot(4, 'none'),
    shot(5, 'previous-shot'),
  ],
  timelineClips: [
    clip(1),
    clip(2),
    clip(3, { joinIn: 'cut' }),
    clip(4, { trimEndSource: 'user', trimEndSeconds: 6, playbackDurationSeconds: 6 }),
    clip(5),
  ],
}];

const names = [
  'Join 1 → 2: exact frame join (chained)',
  'Join 2 → 3: cut',
  'Join 3 → 4: crossfade 0.25 s',
  'Join 4 → 5: chain broken by trim',
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript((seed) => {
    localStorage.setItem('sf_characters', JSON.stringify(seed.characters));
    localStorage.setItem('sf_scenes', JSON.stringify(seed.scenes));
    localStorage.setItem('sf_camera', JSON.stringify({
      shotType: 'medium-shot',
      focalLength: 50,
      tiltAngle: 'eye-level',
      aspectRatio: '16:9',
      showRuleOfThirds: true,
    }));
    localStorage.setItem('sf_exportSettings', JSON.stringify({
      targetEngine: 'unreal-engine',
      exportFormat: 'fbx',
      includeLiveLink: false,
      meshLevel: 'high',
    }));
    localStorage.setItem('sf_updatedAt', '2026-06-10T10:00:00.000Z');
  }, { characters, scenes });
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 800 },
] as const) {
  test.describe(`join labels ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('names every join on the timeline and the export panel', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('timeline-shell')).toBeVisible();
      for (const [index, name] of names.entries()) {
        const join = page.getByTestId(`timeline-join-${index + 1}`);
        await expect(join).toBeVisible();
        await expect(join).toContainText(name);
        await expect(join.getByRole('button')).toHaveCount(0);
      }
      const timeline = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(timeline.violations).toEqual([]);

      await page.getByTestId('prompt-open-pipeline').click();
      await expect(page.getByTestId('workspace-popup-title')).toHaveText('Pipeline');
      await page.getByRole('button', { name: 'Storyboard Mode' }).click();
      const list = page.getByTestId('export-join-list');
      await expect(list).toBeVisible();
      for (const name of names) {
        await expect(list).toContainText(name);
      }
      const exported = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(exported.violations).toEqual([]);
    });
  });
}

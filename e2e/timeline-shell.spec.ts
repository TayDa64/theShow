import { expect, test } from '@playwright/test';

const seededCharacters = [
  {
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
  },
];

const seededScenes = [
  {
    id: 'scene-1',
    title: 'Act I: Handshake Protocol',
    description: 'A quiet meeting in the neon rain.',
    lighting: 'cyberpunk-dusk',
    atmosphereNotes: 'Maintain the alley background.',
    activeBackgroundImageId: 'bg-scene-1',
    dialogues: [
      {
        id: 'dialogue-1',
        characterId: 'char-1',
        text: 'Keep the pacing spread across clips rather than collapsing everything into one generation.',
        sentiment: 'determined',
      },
    ],
    storyboardShots: [
      {
        id: 'shot-1',
        shotNumber: 1,
        title: 'Opening beat',
        shotType: 'medium-shot',
        durationSeconds: 8,
        composition: 'Center the lead in the alley.',
        action: 'Hold on the delivery and reaction.',
        dialogueLineIds: ['dialogue-1'],
        continuityNotes: 'Preserve the same background and wardrobe.',
        generatedClips: [
          {
            id: 'generated-1',
            operationName: 'mock-operation-seeded',
            clipUrl: '',
            durationSeconds: 8,
            createdAt: '2026-06-10T10:00:00.000Z',
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
        title: 'Opening beat',
        selectedSourceClipId: 'generated-1',
        includeInCut: true,
        useFullSource: false,
        preferredDurationSeconds: 5,
        recommendedDurationSeconds: 5,
        sourceDurationSeconds: 8,
        trimStartSeconds: 1,
        trimEndSeconds: 6,
        playbackDurationSeconds: 5,
        backgroundStateId: 'bg-scene-1',
        continuityGroupId: 'scene-1::bg-scene-1',
        holdBackground: true,
        dialogueLineIds: ['dialogue-1'],
        dialogueExcerpt: '',
        sourceHash: 'seeded-source-hash',
        updatedAt: '2026-06-10T10:00:00.000Z',
      },
    ],
  },
];

const seededCamera = {
  shotType: 'medium-shot',
  focalLength: 50,
  tiltAngle: 'eye-level',
  aspectRatio: '16:9',
  showRuleOfThirds: true,
};

const seededExportSettings = {
  targetEngine: 'unreal-engine',
  exportFormat: 'fbx',
  includeLiveLink: false,
  meshLevel: 'high',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((seed) => {
    if (!localStorage.getItem('sf_characters')) {
      localStorage.setItem('sf_characters', JSON.stringify(seed.characters));
    }
    if (!localStorage.getItem('sf_scenes')) {
      localStorage.setItem('sf_scenes', JSON.stringify(seed.scenes));
    }
    if (!localStorage.getItem('sf_camera')) {
      localStorage.setItem('sf_camera', JSON.stringify(seed.camera));
    }
    if (!localStorage.getItem('sf_exportSettings')) {
      localStorage.setItem('sf_exportSettings', JSON.stringify(seed.exportSettings));
    }
    if (!localStorage.getItem('sf_updatedAt')) {
      localStorage.setItem('sf_updatedAt', new Date().toISOString());
    }
  }, {
    characters: seededCharacters,
    scenes: seededScenes,
    camera: seededCamera,
    exportSettings: seededExportSettings,
  });
});

test('keeps timeline primary, removes act list, and places workspace above the prompt dock', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('timeline-shell')).toBeVisible();
  await expect(page.getByTestId('camera-dock')).toBeVisible();
  await expect(page.locator('[data-testid="timeline-act-list"]')).toHaveCount(0);

  const workspaceBox = await page.getByTestId('workspace-dock').boundingBox();
  const promptBox = await page.getByTestId('prompt-dock').boundingBox();

  expect(workspaceBox).not.toBeNull();
  expect(promptBox).not.toBeNull();
  expect(workspaceBox!.y).toBeLessThan(promptBox!.y);
});

test('opens the scene popup, persists it across reload, and closes with save-and-close', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('workspace-button-scenes').click();
  await expect(page.getByTestId('workspace-popup')).toBeVisible();
  await expect(page.getByTestId('workspace-popup-title')).toHaveText('Scenes');
  await expect(page.getByTestId('popup-save-close')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('workspace-popup')).toBeVisible();

  await page.getByTestId('popup-save-close').click();
  await expect(page.getByTestId('workspace-popup')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('workspace-popup')).toHaveCount(0);
});

test('opens the roster and pipeline popups from the timeline shell', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('workspace-button-characters').click();
  await expect(page.getByTestId('workspace-popup')).toBeVisible();
  await expect(page.getByTestId('workspace-popup-title')).toHaveText('Roster');
  await page.getByTestId('popup-close-button').click();
  await expect(page.getByTestId('workspace-popup')).toHaveCount(0);

  await page.getByTestId('prompt-open-pipeline').click();
  await expect(page.getByTestId('workspace-popup')).toBeVisible();
  await expect(page.getByTestId('workspace-popup-title')).toHaveText('Pipeline');
  await expect(page.getByTestId('popup-save-close')).toBeVisible();
});

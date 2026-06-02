import type {
  CameraConfig,
  Character,
  CharacterProperties,
  DialogueLine,
  ReferenceAsset,
  ReferenceAssetKind,
  Scene,
  StoryboardShot,
  StoryboardSeedStrategy,
  StoryboardTransitionMode,
  StoryboardShotType,
} from '../types';

const DEFAULT_CHARACTER_PROPERTIES: CharacterProperties = {
  age: 25,
  build: 'average',
  gender: 'male',
  hairStyle: 'Standard Crop',
  hairColor: 'Jet Black',
  eyeColor: 'Hazel',
  outfit: 'Sleek dark flight jumpsuit with tactical straps.',
  temperament: 'Stoic',
  backstory: 'Synthesized clone designed for sector continuity storytelling.',
  stylePreset: 'cinematic-actor',
};

const STORYBOARD_SHOT_TYPE_ROTATION: StoryboardShotType[] = [
  'wide-landscape',
  'medium-shot',
  'close-up',
  'over-the-shoulder',
  'two-shot',
  'tracking',
];

const SHOT_DURATION_OPTIONS: Array<StoryboardShot['durationSeconds']> = [4, 6, 8];
const STORYBOARD_SEED_STRATEGIES: StoryboardSeedStrategy[] = ['auto', 'lock', 'inherit-previous'];
const STORYBOARD_TRANSITION_MODES: StoryboardTransitionMode[] = ['none', 'previous-shot', 'custom-frame'];

export function createStableId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clampShotDuration(value: number | undefined): StoryboardShot['durationSeconds'] {
  if (!value) return 8;
  return SHOT_DURATION_OPTIONS.reduce((closest, candidate) => {
    return Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest;
  }, 8 as StoryboardShot['durationSeconds']);
}

export function sanitizeStoryboardSeed(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const parsed = typeof value === 'string'
    ? Number(value.trim())
    : typeof value === 'number'
      ? value
      : Number.NaN;

  if (!Number.isFinite(parsed)) return null;

  const rounded = Math.round(parsed);
  if (rounded <= 0) return null;

  return Math.min(rounded, 2147483647);
}

export function createRenderSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

export function normalizeStoryboardSeedStrategy(value: unknown): StoryboardSeedStrategy {
  if (typeof value === 'string' && STORYBOARD_SEED_STRATEGIES.includes(value as StoryboardSeedStrategy)) {
    return value as StoryboardSeedStrategy;
  }

  return 'auto';
}

export function normalizeStoryboardTransitionMode(value: unknown): StoryboardTransitionMode {
  if (typeof value === 'string' && STORYBOARD_TRANSITION_MODES.includes(value as StoryboardTransitionMode)) {
    return value as StoryboardTransitionMode;
  }

  return 'none';
}

function inferAssetOrigin(url: string): ReferenceAsset['origin'] {
  if (url.startsWith('/uploads/')) return 'upload';
  if (url.includes('dicebear') || url.includes('unsplash')) return 'generated';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'remote';
  return 'generated';
}

export function createReferenceAsset(input: {
  id?: string;
  kind: ReferenceAssetKind;
  origin?: ReferenceAsset['origin'];
  label?: string;
  url: string;
  mimeType?: string;
  createdAt?: string;
}): ReferenceAsset {
  return {
    id: input.id || createStableId('asset'),
    kind: input.kind,
    origin: input.origin || inferAssetOrigin(input.url),
    label: input.label || 'Reference image',
    url: input.url,
    mimeType: input.mimeType,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function getCharacterReferenceAssets(character: Character): ReferenceAsset[] {
  return Array.isArray(character.referenceAssets) ? character.referenceAssets : [];
}

export function getSceneBackgroundAssets(scene: Scene): ReferenceAsset[] {
  return Array.isArray(scene.backgroundAssets) ? scene.backgroundAssets : [];
}

export function getSceneStoryboardFrameAssets(scene: Scene): ReferenceAsset[] {
  return Array.isArray(scene.storyboardFrameAssets) ? scene.storyboardFrameAssets : [];
}

export function getCharacterActiveAsset(character: Character): ReferenceAsset | undefined {
  const assets = getCharacterReferenceAssets(character);
  return assets.find(asset => asset.id === character.activeImageId) || assets[0];
}

export function getCharacterDisplayImage(character: Character): string | null {
  return getCharacterActiveAsset(character)?.url || character.thumbnail || null;
}

export function getSceneActiveBackgroundAsset(scene: Scene): ReferenceAsset | undefined {
  const assets = getSceneBackgroundAssets(scene);
  return assets.find(asset => asset.id === scene.activeBackgroundImageId) || assets[0];
}

export function getSceneStoryboardFrameAsset(scene: Scene, assetId: string | null | undefined): ReferenceAsset | undefined {
  if (!assetId) return undefined;
  return getSceneStoryboardFrameAssets(scene).find(asset => asset.id === assetId);
}

export function getSceneDisplayBackground(scene: Scene): string | null {
  return getSceneActiveBackgroundAsset(scene)?.url || null;
}

export function syncCharacterImageState(character: Character): Character {
  const assets = getCharacterReferenceAssets(character);
  const activeAsset = assets.find(asset => asset.id === character.activeImageId) || assets[0];

  return {
    ...character,
    referenceAssets: assets,
    activeImageId: activeAsset?.id || null,
    thumbnail: activeAsset?.url || character.thumbnail || null,
  };
}

export function upsertCharacterAsset(
  character: Character,
  asset: ReferenceAsset,
  makeActive = false,
): Character {
  const previousAssets = getCharacterReferenceAssets(character).filter(existing => existing.id !== asset.id);
  return syncCharacterImageState({
    ...character,
    referenceAssets: [...previousAssets, asset],
    activeImageId: makeActive ? asset.id : (character.activeImageId || asset.id),
  });
}

export function upsertSceneBackgroundAsset(scene: Scene, asset: ReferenceAsset, makeActive = false): Scene {
  const previousAssets = getSceneBackgroundAssets(scene).filter(existing => existing.id !== asset.id);
  return {
    ...scene,
    backgroundAssets: [...previousAssets, asset],
    activeBackgroundImageId: makeActive ? asset.id : (scene.activeBackgroundImageId || asset.id),
  };
}

export function upsertSceneStoryboardFrameAsset(scene: Scene, asset: ReferenceAsset): Scene {
  const previousAssets = getSceneStoryboardFrameAssets(scene).filter(existing => existing.id !== asset.id);
  return {
    ...scene,
    storyboardFrameAssets: [...previousAssets, asset],
  };
}

export function createBlankStoryboardShot(index: number, camera?: CameraConfig): StoryboardShot {
  const shotType = STORYBOARD_SHOT_TYPE_ROTATION[index % STORYBOARD_SHOT_TYPE_ROTATION.length];
  return {
    id: createStableId('shot'),
    shotNumber: index + 1,
    title: `Shot ${index + 1}`,
    shotType,
    durationSeconds: 8,
    focalLength: camera?.focalLength || 50,
    cameraAngle: camera?.tiltAngle || 'eye-level',
    composition: 'Compose the key performance beat clearly within frame.',
    action: 'Define the primary action for this storyboard panel.',
    dialogueLineIds: [],
    dialogueExcerpt: '',
    continuityNotes: 'Preserve costume, facial features, and set continuity from adjacent shots.',
    seedStrategy: 'auto',
    lockedSeed: null,
    lastRenderSeed: null,
    boardImageId: null,
    transitionInMode: index === 0 ? 'none' : 'previous-shot',
    transitionInAssetId: null,
  };
}

function normalizeDialogueLine(raw: Partial<DialogueLine>): DialogueLine {
  return {
    id: raw.id || createStableId('dialogue'),
    characterId: raw.characterId || '',
    text: raw.text || '',
    sentiment: raw.sentiment || 'neutral',
  };
}

export function normalizeStoryboardShot(raw: Partial<StoryboardShot>, index = 0): StoryboardShot {
  return {
    id: raw.id || createStableId('shot'),
    shotNumber: raw.shotNumber || index + 1,
    title: raw.title || `Shot ${index + 1}`,
    shotType: raw.shotType || STORYBOARD_SHOT_TYPE_ROTATION[index % STORYBOARD_SHOT_TYPE_ROTATION.length],
    durationSeconds: clampShotDuration(raw.durationSeconds),
    focalLength: raw.focalLength,
    cameraAngle: raw.cameraAngle || 'eye-level',
    composition: raw.composition || 'Compose the moment with clear subject focus and readable blocking.',
    action: raw.action || raw.dialogueExcerpt || 'Advance the scene through a clear visual beat.',
    dialogueLineIds: Array.isArray(raw.dialogueLineIds) ? raw.dialogueLineIds.map(String) : [],
    dialogueExcerpt: raw.dialogueExcerpt || '',
    continuityNotes: raw.continuityNotes || 'Maintain wardrobe, identity, and environmental continuity.',
    seedStrategy: normalizeStoryboardSeedStrategy(raw.seedStrategy),
    lockedSeed: sanitizeStoryboardSeed(raw.lockedSeed),
    lastRenderSeed: sanitizeStoryboardSeed(raw.lastRenderSeed),
    boardImageId: raw.boardImageId || null,
    transitionInMode: raw.transitionInMode === undefined
      ? (index === 0 ? 'none' : 'previous-shot')
      : normalizeStoryboardTransitionMode(raw.transitionInMode),
    transitionInAssetId: raw.transitionInAssetId || null,
  };
}

export function normalizeCharacter(raw: Partial<Character>): Character {
  const referenceAssets = Array.isArray(raw.referenceAssets)
    ? raw.referenceAssets
        .filter(asset => !!asset?.url)
        .map(asset => createReferenceAsset({
          id: asset.id,
          kind: asset.kind || 'character-upload',
          origin: asset.origin,
          label: asset.label,
          url: asset.url,
          mimeType: asset.mimeType,
          createdAt: asset.createdAt,
        }))
    : [];

  if (raw.thumbnail && !referenceAssets.some(asset => asset.url === raw.thumbnail)) {
    referenceAssets.unshift(createReferenceAsset({
      kind: 'character-generated',
      label: 'Legacy portrait',
      url: raw.thumbnail,
      createdAt: raw.updatedAt,
    }));
  }

  return syncCharacterImageState({
    id: raw.id || createStableId('character'),
    name: raw.name || 'New Subject',
    role: raw.role || 'Archetype',
    thumbnail: raw.thumbnail || null,
    activeImageId: raw.activeImageId || referenceAssets[0]?.id || null,
    referenceAssets,
    properties: {
      ...DEFAULT_CHARACTER_PROPERTIES,
      ...(raw.properties || {}),
    },
    updatedAt: raw.updatedAt || new Date().toISOString(),
  });
}

export function normalizeScene(raw: Partial<Scene>): Scene {
  const backgroundAssets = Array.isArray(raw.backgroundAssets)
    ? raw.backgroundAssets
        .filter(asset => !!asset?.url)
        .map(asset => createReferenceAsset({
          id: asset.id,
          kind: asset.kind || 'scene-background',
          origin: asset.origin,
          label: asset.label,
          url: asset.url,
          mimeType: asset.mimeType,
          createdAt: asset.createdAt,
        }))
    : [];

  const storyboardFrameAssets = Array.isArray(raw.storyboardFrameAssets)
    ? raw.storyboardFrameAssets
        .filter(asset => !!asset?.url)
        .map(asset => createReferenceAsset({
          id: asset.id,
          kind: asset.kind || 'storyboard-frame',
          origin: asset.origin,
          label: asset.label,
          url: asset.url,
          mimeType: asset.mimeType,
          createdAt: asset.createdAt,
        }))
    : [];

  return {
    id: raw.id || createStableId('scene'),
    title: raw.title || 'Untitled Scene',
    lighting: raw.lighting || 'cyberpunk-dusk',
    dialogues: Array.isArray(raw.dialogues) ? raw.dialogues.map(normalizeDialogueLine) : [],
    description: raw.description || '',
    atmosphereNotes: raw.atmosphereNotes || '',
    backgroundAssets,
    storyboardFrameAssets,
    activeBackgroundImageId: raw.activeBackgroundImageId || backgroundAssets[0]?.id || null,
    storyboardShots: Array.isArray(raw.storyboardShots)
      ? raw.storyboardShots.map((shot, index) => normalizeStoryboardShot(shot, index))
      : [],
  };
}

export function normalizeProjectState<T extends {
  characters?: Partial<Character>[] | null;
  scenes?: Partial<Scene>[] | null;
  camera?: CameraConfig | null;
  exportSettings?: Record<string, unknown> | null;
}>(state: T) {
  return {
    ...state,
    characters: Array.isArray(state.characters) ? state.characters.map(normalizeCharacter) : null,
    scenes: Array.isArray(state.scenes) ? state.scenes.map(normalizeScene) : null,
  };
}

export function getShotDialogueLines(scene: Scene, shot: StoryboardShot): DialogueLine[] {
  if (!Array.isArray(scene.dialogues)) return [];
  if (!shot.dialogueLineIds.length) return [];
  return scene.dialogues.filter(line => shot.dialogueLineIds.includes(line.id));
}

export function getShotDialogueExcerpt(scene: Scene, characters: Character[], shot: StoryboardShot): string {
  if (shot.dialogueExcerpt?.trim()) {
    return shot.dialogueExcerpt.trim();
  }

  const lines = getShotDialogueLines(scene, shot);
  if (!lines.length) return '';

  return lines
    .map(line => {
      const speaker = characters.find(character => character.id === line.characterId)?.name || 'Unknown Actor';
      return `${speaker}: ${line.text}`;
    })
    .join(' ');
}

export interface StoryboardContinuityStats {
  totalShots: number;
  downstreamShots: number;
  anchorCount: number;
  previousShotBridgeCount: number;
  missingPreviousAnchorCount: number;
  inheritedSeedCount: number;
  autoSeedCount: number;
}

export function getStoryboardContinuityStats(scene: Scene): StoryboardContinuityStats {
  const shots = Array.isArray(scene.storyboardShots) ? scene.storyboardShots : [];

  return shots.reduce<StoryboardContinuityStats>((stats, rawShot, index) => {
    const shot = normalizeStoryboardShot(rawShot, index);

    stats.totalShots += 1;
    if (shot.boardImageId) {
      stats.anchorCount += 1;
    }

    if (index > 0) {
      stats.downstreamShots += 1;

      if (shot.transitionInMode === 'previous-shot') {
        stats.previousShotBridgeCount += 1;
        const previousShot = shots[index - 1] ? normalizeStoryboardShot(shots[index - 1], index - 1) : undefined;
        if (!previousShot?.boardImageId) {
          stats.missingPreviousAnchorCount += 1;
        }
      }

      if (shot.seedStrategy === 'inherit-previous') {
        stats.inheritedSeedCount += 1;
      }

      if ((shot.seedStrategy || 'auto') === 'auto') {
        stats.autoSeedCount += 1;
      }
    }

    return stats;
  }, {
    totalShots: 0,
    downstreamShots: 0,
    anchorCount: 0,
    previousShotBridgeCount: 0,
    missingPreviousAnchorCount: 0,
    inheritedSeedCount: 0,
    autoSeedCount: 0,
  });
}

export function applyStoryboardContinuityAutomation(
  scene: Scene,
  options?: { syncSeeds?: boolean },
): Scene {
  const syncSeeds = options?.syncSeeds ?? true;
  const shots = Array.isArray(scene.storyboardShots) ? scene.storyboardShots : [];

  const nextShots = shots.map((rawShot, index) => {
    const shot = normalizeStoryboardShot(rawShot, index);

    if (index === 0) {
      return normalizeStoryboardShot({
        ...shot,
        transitionInMode: shot.transitionInMode === 'previous-shot' ? 'none' : shot.transitionInMode,
        transitionInAssetId: shot.transitionInMode === 'previous-shot' ? null : shot.transitionInAssetId,
        seedStrategy: shot.seedStrategy === 'inherit-previous' ? 'auto' : shot.seedStrategy,
      }, index);
    }

    const shouldPreserveCustomBridge = shot.transitionInMode === 'custom-frame' && !!shot.transitionInAssetId;

    return normalizeStoryboardShot({
      ...shot,
      transitionInMode: shouldPreserveCustomBridge ? 'custom-frame' : 'previous-shot',
      transitionInAssetId: shouldPreserveCustomBridge ? shot.transitionInAssetId : null,
      seedStrategy: syncSeeds && shot.seedStrategy === 'auto' ? 'inherit-previous' : shot.seedStrategy,
    }, index);
  });

  return {
    ...scene,
    storyboardShots: nextShots,
  };
}

export function primeNextStoryboardShotContinuity(
  scene: Scene,
  shotId: string,
  options?: { syncSeeds?: boolean },
): Scene {
  const syncSeeds = options?.syncSeeds ?? true;
  const shots = Array.isArray(scene.storyboardShots) ? scene.storyboardShots : [];
  const currentShotIndex = shots.findIndex(shot => shot.id === shotId);

  if (currentShotIndex < 0 || currentShotIndex >= shots.length - 1) {
    return scene;
  }

  const nextShotIndex = currentShotIndex + 1;
  const nextShots = shots.map((rawShot, index) => {
    const shot = normalizeStoryboardShot(rawShot, index);

    if (index !== nextShotIndex) {
      return shot;
    }

    const updates: Partial<StoryboardShot> = {};

    if ((shot.transitionInMode || 'none') === 'none') {
      updates.transitionInMode = 'previous-shot';
      updates.transitionInAssetId = null;
    }

    if (syncSeeds && shot.seedStrategy === 'auto') {
      updates.seedStrategy = 'inherit-previous';
    }

    return Object.keys(updates).length
      ? normalizeStoryboardShot({ ...shot, ...updates }, index)
      : shot;
  });

  return {
    ...scene,
    storyboardShots: nextShots,
  };
}
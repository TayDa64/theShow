import type {
  CameraConfig,
  Character,
  CharacterProperties,
  DialogueLine,
  GeneratedShotClip,
  ProjectTimelineManifest,
  ReferenceAsset,
  ReferenceAssetKind,
  Scene,
  StoryboardShot,
  StoryboardSeedStrategy,
  StoryboardTransitionMode,
  StoryboardShotType,
  TimelineClip,
  TimelineManifestClip,
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
const MIN_TIMELINE_CLIP_DURATION_SECONDS = 0.5;

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

function roundTimelineValue(value: number, precision = 10) {
  return Math.round(value * precision) / precision;
}

function clampTimelineRange(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function estimateDialogueLineDurationSeconds(line: DialogueLine) {
  const text = line.text.trim();
  if (!text) {
    return 1.8;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const punctuationPause = (text.match(/[,.!?;:]/g) || []).length * 0.18;
  const emphasisPause = (text.match(/[—-]/g) || []).length * 0.24;
  return Math.min(Math.max((wordCount / 2.6) + punctuationPause + emphasisPause + 0.8, 1.8), 12);
}

function buildTimelineSourceHash(scene: Scene, shot: StoryboardShot, dialogueLines: DialogueLine[]) {
  return JSON.stringify({
    sceneId: scene.id,
    sceneTitle: scene.title,
    description: scene.description,
    lighting: scene.lighting,
    atmosphereNotes: scene.atmosphereNotes || '',
    activeBackgroundImageId: scene.activeBackgroundImageId || null,
    shotId: shot.id,
    title: shot.title,
    shotType: shot.shotType,
    durationSeconds: shot.durationSeconds,
    composition: shot.composition,
    action: shot.action,
    continuityNotes: shot.continuityNotes,
    transitionInMode: shot.transitionInMode || 'none',
    transitionInAssetId: shot.transitionInAssetId || null,
    seedStrategy: shot.seedStrategy || 'auto',
    dialogue: dialogueLines.map(line => ({
      id: line.id,
      characterId: line.characterId,
      sentiment: line.sentiment,
      text: line.text,
    })),
  });
}

function normalizeGeneratedShotClip(raw: Partial<GeneratedShotClip>): GeneratedShotClip | null {
  if (!raw.operationName) {
    return null;
  }

  const durationSeconds = clampTimelineRange(Number(raw.durationSeconds || 0), 1, 30);
  return {
    id: raw.id || createStableId('generated-clip'),
    operationName: raw.operationName,
    clipUrl: raw.clipUrl || `/api/video-download?operationName=${encodeURIComponent(raw.operationName)}`,
    durationSeconds,
    createdAt: raw.createdAt || new Date().toISOString(),
    resolvedSeed: sanitizeStoryboardSeed(raw.resolvedSeed),
    continuitySource: raw.continuitySource || null,
    usingContinuityFrame: !!raw.usingContinuityFrame,
    providerMode: raw.providerMode || 'sandbox',
  };
}

function normalizeTimelineClip(raw: Partial<TimelineClip>, context: {
  sceneId: string;
  shotId: string;
  title: string;
  order: number;
  backgroundStateId: string;
  continuityGroupId: string;
  dialogueLineIds: string[];
  dialogueExcerpt: string;
  recommendedDurationSeconds: number;
  sourceDurationSeconds: number;
  sourceHash: string;
}) {
  const sourceDurationSeconds = clampTimelineRange(
    Number(raw.sourceDurationSeconds || context.sourceDurationSeconds),
    MIN_TIMELINE_CLIP_DURATION_SECONDS,
    30,
  );
  const trimStartSeconds = clampTimelineRange(
    Number(raw.trimStartSeconds || 0),
    0,
    Math.max(sourceDurationSeconds - MIN_TIMELINE_CLIP_DURATION_SECONDS, 0),
  );
  const trimEndSeconds = clampTimelineRange(
    Number(raw.trimEndSeconds || sourceDurationSeconds),
    trimStartSeconds + MIN_TIMELINE_CLIP_DURATION_SECONDS,
    sourceDurationSeconds,
  );
  const useFullSource = raw.useFullSource ?? false;
  const playbackDurationSeconds = useFullSource
    ? sourceDurationSeconds
    : roundTimelineValue(trimEndSeconds - trimStartSeconds);

  return {
    id: raw.id || createStableId('timeline-clip'),
    sceneId: context.sceneId,
    shotId: context.shotId,
    order: raw.order || context.order,
    title: raw.title || context.title,
    selectedSourceClipId: raw.selectedSourceClipId || null,
    includeInCut: raw.includeInCut ?? true,
    useFullSource,
    preferredDurationSeconds: raw.preferredDurationSeconds === undefined || raw.preferredDurationSeconds === null
      ? null
      : roundTimelineValue(clampTimelineRange(Number(raw.preferredDurationSeconds), 1, 30)),
    recommendedDurationSeconds: roundTimelineValue(clampTimelineRange(context.recommendedDurationSeconds, 1, 30)),
    sourceDurationSeconds,
    trimStartSeconds: roundTimelineValue(trimStartSeconds),
    trimEndSeconds: roundTimelineValue(trimEndSeconds),
    playbackDurationSeconds,
    backgroundStateId: raw.backgroundStateId || context.backgroundStateId,
    continuityGroupId: raw.continuityGroupId || context.continuityGroupId,
    holdBackground: raw.holdBackground ?? true,
    dialogueLineIds: Array.isArray(raw.dialogueLineIds) ? raw.dialogueLineIds.map(String) : context.dialogueLineIds,
    dialogueExcerpt: raw.dialogueExcerpt || context.dialogueExcerpt,
    sourceHash: raw.sourceHash || context.sourceHash,
    dirty: !!raw.dirty,
    dirtyReason: raw.dirtyReason || null,
    updatedAt: raw.updatedAt || new Date().toISOString(),
  } satisfies TimelineClip;
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
  const generatedClips = Array.isArray(raw.generatedClips)
    ? raw.generatedClips
        .map((clip) => normalizeGeneratedShotClip(clip))
        .filter((clip): clip is GeneratedShotClip => !!clip)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    : [];
  const activeGeneratedClipId = raw.activeGeneratedClipId && generatedClips.some((clip) => clip.id === raw.activeGeneratedClipId)
    ? raw.activeGeneratedClipId
    : generatedClips.at(-1)?.id || null;

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
    generatedClips,
    activeGeneratedClipId,
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

  const normalizedShots = Array.isArray(raw.storyboardShots)
    ? raw.storyboardShots.map((shot, index) => normalizeStoryboardShot(shot, index))
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
    storyboardShots: normalizedShots,
    timelineClips: Array.isArray(raw.timelineClips)
      ? raw.timelineClips
          .map((clip) => {
            const shot = normalizedShots.find((candidate) => candidate.id === clip.shotId);
            return shot ? normalizeTimelineClip(clip, {
              sceneId: raw.id || 'scene',
              shotId: shot.id,
              title: shot.title,
              order: clip.order || shot.shotNumber,
              backgroundStateId: raw.activeBackgroundImageId || backgroundAssets[0]?.id || `scene-bg-${raw.id || 'scene'}`,
              continuityGroupId: `${raw.id || 'scene'}::${raw.activeBackgroundImageId || 'default-bg'}`,
              dialogueLineIds: Array.isArray(clip.dialogueLineIds) ? clip.dialogueLineIds.map(String) : shot.dialogueLineIds,
              dialogueExcerpt: clip.dialogueExcerpt || '',
              recommendedDurationSeconds: Number(clip.recommendedDurationSeconds || shot.durationSeconds || 8),
              sourceDurationSeconds: Number(clip.sourceDurationSeconds || shot.durationSeconds || 8),
              sourceHash: clip.sourceHash || '',
            }) : null;
          })
          .filter(isDefined)
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

export function getStoryboardShotActiveGeneratedClip(shot: StoryboardShot | undefined) {
  if (!shot?.generatedClips?.length) {
    return null;
  }

  return shot.generatedClips.find((clip) => clip.id === shot.activeGeneratedClipId)
    || shot.generatedClips.at(-1)
    || null;
}

export function estimateStoryboardShotDuration(scene: Scene, shot: StoryboardShot) {
  const dialogueLines = getShotDialogueLines(scene, shot);
  const dialogueDurationSeconds = dialogueLines.length
    ? dialogueLines.reduce((total, line) => total + estimateDialogueLineDurationSeconds(line), 0)
    : (shot.dialogueExcerpt?.trim()
        ? estimateDialogueLineDurationSeconds({
            id: shot.id,
            characterId: '',
            text: shot.dialogueExcerpt,
            sentiment: 'neutral',
          })
        : 2.2);
  const speakerChangeBuffer = Math.max(dialogueLines.length - 1, 0) * 0.45;
  const cinematicBuffer = shot.shotType === 'wide-landscape' || shot.shotType === 'tracking'
    ? 1.6
    : shot.shotType === 'two-shot' || shot.shotType === 'over-the-shoulder'
      ? 1.2
      : 0.8;
  const continuityBuffer = (shot.transitionInMode || 'none') === 'none' ? 0.2 : 0.6;
  const actionWordCount = shot.action.trim().split(/\s+/).filter(Boolean).length;
  const actionBuffer = actionWordCount > 12 ? 1.4 : actionWordCount > 5 ? 0.9 : 0.4;
  const recommendedDurationSeconds = roundTimelineValue(
    clampTimelineRange(
      dialogueDurationSeconds + speakerChangeBuffer + cinematicBuffer + continuityBuffer + actionBuffer,
      2,
      20,
    ),
  );

  return {
    recommendedDurationSeconds,
    dialogueDurationSeconds: roundTimelineValue(dialogueDurationSeconds),
  };
}

export function syncSceneTimeline(scene: Scene) {
  const normalizedScene = normalizeScene(scene);
  const shots = normalizedScene.storyboardShots || [];
  const existingTimelineClips = new Map(
    (normalizedScene.timelineClips || []).map((clip) => [clip.shotId, clip]),
  );
  const backgroundStateId = normalizedScene.activeBackgroundImageId || `scene-bg-${normalizedScene.id}`;
  const continuityGroupId = `${normalizedScene.id}::${backgroundStateId}`;

  const nextTimelineClips = shots.map((shot, index) => {
    const existing = existingTimelineClips.get(shot.id);
    const { recommendedDurationSeconds } = estimateStoryboardShotDuration(normalizedScene, shot);
    const sourceClip = shot.generatedClips?.find((clip) => clip.id === existing?.selectedSourceClipId)
      || getStoryboardShotActiveGeneratedClip(shot);
    const sourceDurationSeconds = roundTimelineValue(
      clampTimelineRange(
        Number(sourceClip?.durationSeconds || shot.durationSeconds || recommendedDurationSeconds),
        MIN_TIMELINE_CLIP_DURATION_SECONDS,
        30,
      ),
    );
    const recommendedPlayback = sourceClip
      ? Math.min(sourceDurationSeconds, recommendedDurationSeconds)
      : recommendedDurationSeconds;
    const dialogueExcerpt = shot.dialogueExcerpt?.trim()
      || getShotDialogueLines(normalizedScene, shot).map((line) => line.text.trim()).filter(Boolean).join(' ')
      || shot.action;
    const sourceHash = buildTimelineSourceHash(normalizedScene, shot, getShotDialogueLines(normalizedScene, shot));

    const nextClip = normalizeTimelineClip(existing || {}, {
      sceneId: normalizedScene.id,
      shotId: shot.id,
      title: shot.title,
      order: index + 1,
      backgroundStateId,
      continuityGroupId,
      dialogueLineIds: shot.dialogueLineIds,
      dialogueExcerpt,
      recommendedDurationSeconds: recommendedPlayback,
      sourceDurationSeconds,
      sourceHash,
    });

    const selectedSourceClipId = sourceClip?.id || null;
    const preferredDurationSeconds = existing?.preferredDurationSeconds ?? recommendedDurationSeconds;
    const trimStartSeconds = clampTimelineRange(
      nextClip.useFullSource ? 0 : nextClip.trimStartSeconds,
      0,
      Math.max(sourceDurationSeconds - MIN_TIMELINE_CLIP_DURATION_SECONDS, 0),
    );
    const trimEndSeconds = nextClip.useFullSource
      ? sourceDurationSeconds
      : clampTimelineRange(
          existing?.trimEndSeconds ?? Math.min(sourceDurationSeconds, preferredDurationSeconds),
          trimStartSeconds + MIN_TIMELINE_CLIP_DURATION_SECONDS,
          sourceDurationSeconds,
        );
    const playbackDurationSeconds = nextClip.useFullSource
      ? sourceDurationSeconds
      : roundTimelineValue(trimEndSeconds - trimStartSeconds);

    let dirtyReason: string | null = null;
    if (!sourceClip) {
      dirtyReason = 'Render this storyboard shot to attach a reusable source clip.';
    } else if (existing?.sourceHash && existing.sourceHash !== sourceHash) {
      dirtyReason = 'Dialogue, continuity, or background changed after the selected source clip was generated.';
    } else if (recommendedDurationSeconds > sourceDurationSeconds + 0.5) {
      dirtyReason = `Recommended pacing is ${recommendedDurationSeconds}s, but the selected source clip is only ${sourceDurationSeconds}s.`;
    }

    return {
      ...nextClip,
      selectedSourceClipId,
      preferredDurationSeconds: roundTimelineValue(clampTimelineRange(preferredDurationSeconds, 1, 30)),
      trimStartSeconds: roundTimelineValue(trimStartSeconds),
      trimEndSeconds: roundTimelineValue(trimEndSeconds),
      playbackDurationSeconds,
      sourceDurationSeconds,
      recommendedDurationSeconds: roundTimelineValue(recommendedDurationSeconds),
      dirty: !!dirtyReason,
      dirtyReason,
      sourceHash,
      updatedAt: new Date().toISOString(),
    } satisfies TimelineClip;
  });

  return {
    ...normalizedScene,
    timelineClips: nextTimelineClips,
  };
}

export function buildProjectTimelineManifest(scenes: Scene[]): ProjectTimelineManifest {
  const syncedScenes = scenes.map(syncSceneTimeline);
  const clips: TimelineManifestClip[] = [];

  syncedScenes.forEach((scene, sceneIndex) => {
    (scene.timelineClips || []).forEach((clip, clipIndex) => {
      const shot = scene.storyboardShots?.find((candidate) => candidate.id === clip.shotId);
      const sourceClip = shot?.generatedClips?.find((candidate) => candidate.id === clip.selectedSourceClipId)
        || getStoryboardShotActiveGeneratedClip(shot);

      clips.push({
        ...clip,
        clipId: clip.id,
        sceneTitle: scene.title,
        shotNumber: shot?.shotNumber || clipIndex + 1,
        order: sceneIndex * 1000 + clipIndex + 1,
        operationName: sourceClip?.operationName || null,
        clipUrl: sourceClip?.clipUrl || null,
        resolvedSeed: sourceClip?.resolvedSeed ?? shot?.lastRenderSeed ?? null,
        continuitySource: sourceClip?.continuitySource || null,
        usingContinuityFrame: !!sourceClip?.usingContinuityFrame,
        sourceCreatedAt: sourceClip?.createdAt || null,
      });
    });
  });

  const includedClips = clips.filter((clip) => clip.includeInCut);
  const readyClipCount = includedClips.filter((clip) => !!clip.operationName).length;
  const dirtyClipCount = includedClips.filter((clip) => !!clip.dirty).length;

  return {
    generatedAt: new Date().toISOString(),
    totalClipCount: clips.length,
    includedClipCount: includedClips.length,
    readyClipCount,
    dirtyClipCount,
    estimatedDurationSeconds: roundTimelineValue(
      includedClips.reduce((total, clip) => total + clip.playbackDurationSeconds, 0),
    ),
    clips,
  };
}
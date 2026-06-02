export type ViewState = 'characters' | 'scenes' | 'cameras' | 'export';

export type ReferenceAssetKind =
  | 'character-upload'
  | 'character-generated'
  | 'scene-background'
  | 'storyboard-frame';

export type ReferenceAssetOrigin = 'upload' | 'generated' | 'remote';

export interface ReferenceAsset {
  id: string;
  kind: ReferenceAssetKind;
  origin: ReferenceAssetOrigin;
  label: string;
  url: string;
  mimeType?: string;
  createdAt: string;
}

export interface CharacterProperties {
  age: number;
  build: string;
  gender: string;
  hairStyle: string;
  hairColor: string;
  eyeColor: string;
  outfit: string;
  temperament: string;
  backstory: string;
  stylePreset?: string;
}

export interface Character {
  id: string;
  name: string;
  role: string;
  thumbnail: null | string;
  activeImageId?: string | null;
  referenceAssets?: ReferenceAsset[];
  properties: CharacterProperties;
  updatedAt: string;
}

export interface DialogueLine {
  id: string;
  characterId: string;
  text: string;
  sentiment: 'neutral' | 'tense' | 'playful' | 'mysterious' | 'determined';
}

export type StoryboardShotType =
  | CameraConfig['shotType']
  | 'two-shot'
  | 'over-the-shoulder'
  | 'tracking';

export type StoryboardSeedStrategy = 'auto' | 'lock' | 'inherit-previous';
export type StoryboardTransitionMode = 'none' | 'previous-shot' | 'custom-frame';

export interface StoryboardShot {
  id: string;
  shotNumber: number;
  title: string;
  shotType: StoryboardShotType;
  durationSeconds: 4 | 6 | 8;
  focalLength?: number;
  cameraAngle?: CameraConfig['tiltAngle'];
  composition: string;
  action: string;
  dialogueLineIds: string[];
  dialogueExcerpt?: string;
  continuityNotes: string;
  seedStrategy?: StoryboardSeedStrategy;
  lockedSeed?: number | null;
  lastRenderSeed?: number | null;
  boardImageId?: string | null;
  transitionInMode?: StoryboardTransitionMode;
  transitionInAssetId?: string | null;
}

export interface Scene {
  id: string;
  title: string;
  lighting: 'cyberpunk-dusk' | 'sunset-warm' | 'moonlight-cold' | 'high-key-studio';
  dialogues: DialogueLine[];
  description: string;
  atmosphereNotes?: string;
  backgroundAssets?: ReferenceAsset[];
  storyboardFrameAssets?: ReferenceAsset[];
  activeBackgroundImageId?: string | null;
  storyboardShots?: StoryboardShot[];
}

export interface CameraConfig {
  shotType: 'close-up' | 'medium-shot' | 'cowboy-shot' | 'wide-landscape';
  focalLength: number; // e.g. 24, 35, 50, 85, 200
  tiltAngle: 'low' | 'eye-level' | 'high';
  aspectRatio: '16:9' | '9:16';
  showRuleOfThirds: boolean;
}

export interface ExportSettings {
  targetEngine: 'blender' | 'unreal-engine' | 'unity';
  exportFormat: 'gltf' | 'fbx' | 'usd';
  includeLiveLink: boolean;
  meshLevel: 'high' | 'medium' | 'low';
}

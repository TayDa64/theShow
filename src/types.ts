export type ViewState = 'characters' | 'scenes' | 'cameras' | 'export';

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
  properties: CharacterProperties;
  updatedAt: string;
}

export interface DialogueLine {
  id: string;
  characterId: string;
  text: string;
  sentiment: 'neutral' | 'tense' | 'playful' | 'mysterious' | 'determined';
}

export interface Scene {
  id: string;
  title: string;
  lighting: 'cyberpunk-dusk' | 'sunset-warm' | 'moonlight-cold' | 'high-key-studio';
  dialogues: DialogueLine[];
  description: string;
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

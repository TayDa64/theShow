export type ViewState = 'characters' | 'scenes' | 'cameras' | 'timeline' | 'export';

export type AuthViewState = 'account';

export type AppViewState = ViewState | AuthViewState;

export type WorkspaceSyncState = 'LOCAL' | 'SYNCING' | 'SYNCED';

export type GenerationProviderMode = 'personal' | 'workspace' | 'sandbox';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  avatarUrl?: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
  twoFactorEnabled: boolean;
}

export interface AuthSessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
  userAgent?: string | null;
  ipPreview?: string | null;
}

export interface ProviderConnectionSummary {
  mode: GenerationProviderMode;
  status: 'connected' | 'disconnected';
  providerType: 'gemini-api-key' | 'workspace-key' | 'sandbox';
  label: string;
  maskedApiKey?: string | null;
  connectedAt?: string | null;
  dailyVideoLimit?: number | null;
  usedToday: number;
  remainingToday?: number | null;
  liveVideoEnabled: boolean;
  sandboxFallbackEnabled: boolean;
  note?: string | null;
}

export interface AuthAuditEvent {
  id: string;
  type: string;
  detail: string;
  createdAt: string;
}

export interface AuthCapabilities {
  cloudSync: boolean;
  aiTools: boolean;
  liveVideo: boolean;
  sandboxFallback: boolean;
  googleOidc: boolean;
  localTwoFactor: boolean;
}

export interface AuthIdentitySummary {
  googleOidcConfigured: boolean;
  googleLinked: boolean;
  passwordLoginEnabled: boolean;
  twoFactorEnabled: boolean;
}

export interface TwoFactorChallenge {
  challengeId: string;
  email: string;
  expiresAt: string;
}

export interface TwoFactorSetup {
  issuer: string;
  accountName: string;
  manualEntryKey: string;
  otpAuthUrl: string;
  qrCodeDataUrl: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  user: AuthUser | null;
  csrfToken: string | null;
  provider: ProviderConnectionSummary;
  sessions: AuthSessionSummary[];
  auditEvents: AuthAuditEvent[];
  capabilities: AuthCapabilities;
  identity: AuthIdentitySummary;
}

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

export interface GeneratedShotClip {
  id: string;
  operationName: string;
  clipUrl: string;
  durationSeconds: number;
  createdAt: string;
  resolvedSeed?: number | null;
  continuitySource?: string | null;
  usingContinuityFrame?: boolean;
  providerMode?: GenerationProviderMode;
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
  generatedClips?: GeneratedShotClip[];
  activeGeneratedClipId?: string | null;
}

export interface TimelineClip {
  id: string;
  sceneId: string;
  shotId: string;
  order: number;
  title: string;
  selectedSourceClipId?: string | null;
  includeInCut: boolean;
  useFullSource: boolean;
  preferredDurationSeconds?: number | null;
  recommendedDurationSeconds: number;
  sourceDurationSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  playbackDurationSeconds: number;
  backgroundStateId: string;
  continuityGroupId: string;
  holdBackground: boolean;
  dialogueLineIds: string[];
  dialogueExcerpt?: string;
  sourceHash: string;
  dirty?: boolean;
  dirtyReason?: string | null;
  updatedAt: string;
}

export interface TimelineManifestClip extends TimelineClip {
  clipId: string;
  sceneTitle: string;
  shotNumber: number;
  operationName?: string | null;
  clipUrl?: string | null;
  resolvedSeed?: number | null;
  continuitySource?: string | null;
  usingContinuityFrame?: boolean;
  sourceCreatedAt?: string | null;
}

export interface ProjectTimelineManifest {
  generatedAt: string;
  totalClipCount: number;
  includedClipCount: number;
  readyClipCount: number;
  dirtyClipCount: number;
  estimatedDurationSeconds: number;
  clips: TimelineManifestClip[];
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
  timelineClips?: TimelineClip[];
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

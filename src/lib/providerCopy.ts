/**
 * User-visible engine names. Video copy follows `videoBackend`.
 * AI-text copy follows whether a Gemini key exists (`mode` personal/workspace).
 * A result may name Gemini only when that response was not a local fallback.
 */
export type VideoBackendId = 'grok' | 'gemini' | 'sandbox';

export type ProviderCopyMode = 'personal' | 'workspace' | 'sandbox' | 'none';

export type ProviderCopySource = {
  videoBackend?: VideoBackendId | null;
  mode?: ProviderCopyMode | null;
  videoBilling?: string | null;
};

export type ProviderCopy = {
  backend: VideoBackendId;
  engineName: string;
  videoUsesGemini: boolean;
  textUsesGemini: boolean;
  quickPreviewTitle: string;
  storyboardTitle: string;
  storyboardBlurb: string;
  filmSheetNote: string;
  characterStyleLabel: string;
  sceneStoryboardIntro: string;
  aiSuggestTitle: string;
  compilingLabel: string;
  handoffError: string;
};

const GROK_STORYBOARD_BLURB = 'Each storyboard shot is its own Grok clip. Review the exact prompt and the quote, then confirm. A pinned start frame stays in the image.';
const GROK_FILM_SHEET = 'Review the exact prompt, the pinned frame, and the quote. Confirm spends one clip per shot. A shot set to no transition is not pinned to the previous frame.';
const GEMINI_STORYBOARD_BLURB = 'Continuity-first Veo 3.1 workflow: each storyboard shot becomes its own clip, with up to 3 total reference images and 8-second reference mode constraints.';
const GEMINI_FILM_SHEET = 'Veo 3.1 reference-image mode supports up to 3 total reference images per shot and requires 8-second shots when references are used. Successful renders auto-save anchor frames for downstream continuity.';
const SANDBOX_STORYBOARD_BLURB = 'Sandbox storyboard renderer: each storyboard shot becomes its own clip.';
const SANDBOX_FILM_SHEET = 'Sandbox preview renders each storyboard shot as its own clip. Successful renders auto-save anchor frames for downstream continuity.';
const SCENE_INTRO_GEMINI = 'Break long dialogue into cinematic panels so each shot can render as its own Veo clip instead of being compressed into one video.';
const SCENE_INTRO_NEUTRAL = 'Break long dialogue into cinematic panels so each shot can render as its own clip instead of being compressed into one video.';

export function normalizeVideoBackend(backend: string | null | undefined): VideoBackendId {
  switch (backend) {
    case 'grok':
    case 'gemini':
    case 'sandbox':
      return backend;
    default:
      return 'sandbox';
  }
}

export function engineName(backend: VideoBackendId): string {
  switch (backend) {
    case 'grok':
      return 'Grok Imagine Video';
    case 'gemini':
      return 'Gemini Veo';
    case 'sandbox':
      return 'Sandbox preview';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export function videoUsesGemini(backend: VideoBackendId | null | undefined): boolean {
  return backend === 'gemini';
}

export function textUsesGemini(mode: ProviderCopyMode | null | undefined): boolean {
  return mode === 'personal' || mode === 'workspace';
}

export function resultNamesGemini(
  mode: ProviderCopyMode | null | undefined,
  response: { fallback?: boolean } | null | undefined,
): boolean {
  return textUsesGemini(mode) && response?.fallback !== true;
}

export function contractSeedNote(backend: VideoBackendId): string {
  switch (backend) {
    case 'grok':
      return 'Grok does not receive the seed. The seed stays on this card.';
    case 'gemini':
      return 'Veo receives the seed on this card.';
    case 'sandbox':
      return 'Sandbox preview keeps this seed on the card. Nothing is sent to a live video engine.';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export function contractQuoteBasis(backend: VideoBackendId): string {
  switch (backend) {
    case 'grok':
      return 'Grok Imagine Video prices this clip from the per-second table.';
    case 'gemini':
      return 'This path uses Veo. The Grok per-second table does not price it.';
    case 'sandbox':
      return 'Sandbox preview. Nothing is billed.';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export function sequenceCompilingLabel(backend: VideoBackendId): string {
  return backend === 'gemini' ? 'Veo Sequence compiling...' : 'Sequence compiling...';
}

export function videoHandoffError(backend: VideoBackendId): string {
  return backend === 'gemini'
    ? 'Failed to hand off prompt parameters to the Veo video engine.'
    : 'Failed to hand off prompt parameters to the video engine.';
}

export function referenceModeBadge(usingReferences: boolean, backend: VideoBackendId): string {
  if (!usingReferences) return 'Prompt-only mode';
  return backend === 'gemini' ? 'Reference-image mode (Veo 3.1 / 8s)' : 'Reference-image mode';
}

export function quotaExhaustedShotNote(backend: VideoBackendId): string {
  return backend === 'gemini'
    ? 'Veo quota was exhausted for this shot, so sandbox fallback media was used instead.'
    : 'Live quota was exhausted for this shot, so sandbox fallback media was used instead.';
}

export function quotaCapacityBadge(backend: VideoBackendId): string {
  return backend === 'gemini'
    ? 'Veo API capacity limit reached (Sandbox pre-visualization active)'
    : 'Preview capacity limit reached (Sandbox pre-visualization active)';
}

export function quotaExplainer(backend: VideoBackendId): string {
  return backend === 'gemini'
    ? 'The Google GenAI Veo quick-preview model can return 429 Resource Exhausted until billing and quota are configured.'
    : 'Sandbox preview is showing a simulated clip because a live video render is not available.';
}

export function exportCustomBridgeSummary(backend: VideoBackendId, label: string): string {
  const slot = backend === 'gemini' ? 'Veo reference slot' : 'reference slot';
  return `One ${slot} will be reserved for the custom bridge frame “${label}” before character/background refs.`;
}

export function exportPreviousAnchorSummary(backend: VideoBackendId, shotIndex: number, label: string): string {
  const slot = backend === 'gemini' ? 'Veo reference slot' : 'reference slot';
  return `One ${slot} will be reserved for Shot ${shotIndex}'s anchor frame “${label}”.`;
}

export function scenesCustomBridgeSummary(backend: VideoBackendId, label: string | undefined): string {
  if (backend === 'gemini') {
    return label
      ? `One of the 3 Veo reference slots will be reserved for the custom continuity frame “${label}” before character/background references are added.`
      : 'Choose or upload a custom continuity frame to reserve one Veo reference slot for the bridge-in image.';
  }
  return label
    ? `One reference slot will be reserved for the custom continuity frame “${label}” before character and background references are added.`
    : 'Choose or upload a custom continuity frame to reserve one reference slot for the bridge-in image.';
}

export function scenesPreviousAnchorSummary(
  backend: VideoBackendId,
  shotNumber: number,
  previousNumber: number,
  label: string,
): string {
  if (backend === 'gemini') {
    return `Shot ${shotNumber} will reserve one Veo reference slot for Shot ${previousNumber}'s anchor frame “${label}”, then fill the remaining slots with lead character/background continuity.`;
  }
  return `Shot ${shotNumber} will reserve one reference slot for Shot ${previousNumber}'s anchor frame “${label}”, then fill the remaining slots with character and background continuity.`;
}

export function renderStatusLabel(input: ProviderCopySource & { isAuthenticated: boolean }): string {
  if (!input.isAuthenticated) return 'Account sign-in required';
  const backend = normalizeVideoBackend(input.videoBackend);
  const billing = input.videoBilling || 'Grok subscription';
  switch (backend) {
    case 'grok':
      return `Grok Imagine Video active — billed to ${billing}`;
    case 'gemini':
      if (input.mode === 'personal') return 'Personal Gemini provider active';
      if (input.mode === 'workspace') return 'Workspace Gemini provider active';
      return 'Gemini Veo active';
    case 'sandbox':
      return 'Sandbox-only render mode';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export type StatusTone = 'amber' | 'emerald' | 'indigo' | 'zinc';

export function renderStatusTone(input: ProviderCopySource & { isAuthenticated: boolean }): StatusTone {
  if (!input.isAuthenticated) return 'amber';
  const backend = normalizeVideoBackend(input.videoBackend);
  switch (backend) {
    case 'grok':
      return 'emerald';
    case 'gemini':
      return input.mode === 'workspace' ? 'indigo' : 'emerald';
    case 'sandbox':
      return 'zinc';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export function renderAccessMessage(input: ProviderCopySource & {
  isAuthenticated: boolean;
  remainingToday?: number | null;
  dailyVideoLimit?: number | null;
}): string {
  if (!input.isAuthenticated) {
    return 'Sign in from the Account dashboard to unlock secure video rendering, storyboard queues, and cloud-backed export actions.';
  }
  const backend = normalizeVideoBackend(input.videoBackend);
  const billing = input.videoBilling || 'Grok subscription';
  switch (backend) {
    case 'grok':
      return `Rendering with Grok Imagine Video, billed to your ${billing}. Shots render live and download into this project.`;
    case 'gemini':
      if (input.mode === 'personal') {
        return `${input.remainingToday ?? 0} of ${input.dailyVideoLimit ?? 0} personal live video generations remain today. Sandbox fallback is still available for safe mock workflows.`;
      }
      if (input.mode === 'workspace') {
        return 'Authenticated and using the workspace Gemini API provider for live generation. Connect a personal key in Account if you want isolated quota ownership.';
      }
      return 'Rendering with Gemini Veo. Sandbox fallback remains available when the live engine cannot take the shot.';
    case 'sandbox':
      return 'Authenticated in sandbox-only mode. theShow can still run local mock preview flows.';
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }
}

export function providerCopy(provider: ProviderCopySource): ProviderCopy {
  const backend = normalizeVideoBackend(provider.videoBackend);
  const geminiVideo = backend === 'gemini';
  const geminiText = textUsesGemini(provider.mode);
  let storyboardBlurb = SANDBOX_STORYBOARD_BLURB;
  let filmSheetNote = SANDBOX_FILM_SHEET;
  let quickPreviewTitle = 'Sandbox quick preview';
  let storyboardTitle = 'Sandbox storyboard renderer';
  switch (backend) {
    case 'grok':
      storyboardBlurb = GROK_STORYBOARD_BLURB;
      filmSheetNote = GROK_FILM_SHEET;
      quickPreviewTitle = 'Grok quick preview';
      storyboardTitle = 'Grok storyboard renderer';
      break;
    case 'gemini':
      storyboardBlurb = GEMINI_STORYBOARD_BLURB;
      filmSheetNote = GEMINI_FILM_SHEET;
      quickPreviewTitle = 'Veo quick preview';
      storyboardTitle = 'Veo storyboard renderer';
      break;
    case 'sandbox':
      break;
    default: {
      const unexpected: never = backend;
      return unexpected;
    }
  }

  return {
    backend,
    engineName: engineName(backend),
    videoUsesGemini: geminiVideo,
    textUsesGemini: geminiText,
    quickPreviewTitle,
    storyboardTitle,
    storyboardBlurb,
    filmSheetNote,
    characterStyleLabel: geminiVideo ? 'Google Veo Character Style' : 'Character style',
    sceneStoryboardIntro: geminiVideo ? SCENE_INTRO_GEMINI : SCENE_INTRO_NEUTRAL,
    aiSuggestTitle: geminiText ? 'Auto-suggest dialogue using Gemini AI' : 'Auto-suggest dialogue',
    compilingLabel: sequenceCompilingLabel(backend),
    handoffError: videoHandoffError(backend),
  };
}

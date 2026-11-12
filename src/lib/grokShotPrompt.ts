/**
 * Affirmative motion prompt for the studio Grok shot route.
 *
 * Veo keeps `buildShotPrompt`. This compiler is only for
 * POST /api/generate-shot-video when the backend is Grok. The old don'ts are
 * stored on the job and checked by the lint; they are not a request field.
 */

export const GROK_SHOT_STORED_NEGATIVE = [
  "Do not include subtitles or any visible text in frame.",
  "without on-screen subtitles",
  "Avoid subtitles, text overlays, logos, watermarks, costume drift, face drift, duplicated limbs, abrupt environment changes, or extra unnamed characters.",
].join("\n");

const STUDIO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type StudioGrokResolution = (typeof STUDIO_RESOLUTIONS)[number];

/** 720p when the caller left resolution unset. An explicit 480p or 1080p stays. */
export function studioGrokResolution(value: unknown): StudioGrokResolution {
  if (value === "480p" || value === "720p" || value === "1080p") return value;
  return "720p";
}

export function studioVoiceId(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function clampShotSeconds(value: number): number {
  return Math.min(15, Math.max(1, Math.round(value)));
}

/**
 * Size the clip to an explicit track duration when one was supplied.
 * Otherwise keep the shot's own duration. A missing shot duration stays 8.
 */
export function durationForStudioGrokShot(shotSeconds: unknown, trackSeconds: unknown): number {
  const track = Number(trackSeconds);
  const hasTrack =
    trackSeconds !== undefined &&
    trackSeconds !== null &&
    trackSeconds !== "" &&
    Number.isFinite(track) &&
    track > 0;
  if (hasTrack) return clampShotSeconds(track);
  const shot = Number(shotSeconds);
  if (!Number.isFinite(shot) || shot <= 0) return 8;
  return clampShotSeconds(shot);
}

export type GrokShotPromptInput = {
  action?: string;
  shotType?: string;
  cameraAngle?: string;
  focalLength?: number | string;
  aspectRatio?: string;
  sceneDescription?: string;
  lighting?: string;
  pinnedFrame: boolean;
  dialogue?: string;
  voiceId?: string;
};

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Motion and camera, in the affirmative. When a frame is already pinned, the
 * room stays in that picture and is left out of the prompt. A shot with no
 * pinned frame still names the setting, because the picture has to be made.
 */
export function buildGrokShotPrompt(input: GrokShotPromptInput): string {
  const action = textOrEmpty(input.action) || "The performer continues the beat.";
  const shotType = textOrEmpty(input.shotType) || "medium-shot";
  const angle = textOrEmpty(input.cameraAngle) || "eye-level";
  const focal =
    input.focalLength === undefined || input.focalLength === null || input.focalLength === ""
      ? "50"
      : String(input.focalLength);
  const aspect = textOrEmpty(input.aspectRatio) || "16:9";
  const lines = [
    `Action: ${action}`,
    `Camera: ${angle} angle, ${focal}mm lens, ${shotType}, ${aspect} frame.`,
  ];

  if (!input.pinnedFrame) {
    const setting = textOrEmpty(input.sceneDescription);
    const light = textOrEmpty(input.lighting);
    if (setting) lines.push(`Setting: ${setting}`);
    if (light) lines.push(`Light: ${light}`);
  }

  const dialogue = textOrEmpty(input.dialogue);
  const voice = textOrEmpty(input.voiceId);
  if (dialogue && voice) {
    lines.push(`The performer speaks this line once, briskly, using the voice in <AUDIO_0>: "${dialogue}"`);
  } else if (dialogue) {
    lines.push(`Spoken line: "${dialogue}"`);
  }

  return lines.join("\n");
}

export type StudioReferenceCutout =
  | { ok: true; path: string }
  | { ok: false };

/**
 * Person portraits may become reference images. The pinned start frame stays
 * out of that list. A local portrait is replaced by its feathered cutout when
 * the cutout succeeds; a remote portrait is passed through.
 */
export async function studioGrokReferenceUrls(input: {
  personUrls: Array<string | null | undefined>;
  backgroundUrl?: string | null;
  pinnedUrl?: string | null;
  resolve: (url: string) => string | null;
  cutout?: (localPath: string) => Promise<StudioReferenceCutout>;
}): Promise<string[]> {
  const pinnedRaw = input.pinnedUrl?.trim() || null;
  const pinnedResolved = pinnedRaw ? input.resolve(pinnedRaw) ?? pinnedRaw : null;
  const isPinned = (url: string, resolved: string | null) =>
    (pinnedRaw !== null && url === pinnedRaw) ||
    (pinnedResolved !== null && (url === pinnedResolved || resolved === pinnedResolved));

  const refs: string[] = [];
  for (const candidate of input.personUrls) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const url = candidate.trim();
    const resolved = input.resolve(url);
    if (!resolved || isPinned(url, resolved)) continue;
    const local = !/^https?:/i.test(resolved) && !resolved.startsWith("data:");
    if (local && input.cutout) {
      const cut = await input.cutout(resolved);
      refs.push(cut.ok ? cut.path : resolved);
    } else {
      refs.push(resolved);
    }
  }

  const background = textOrEmpty(input.backgroundUrl);
  if (background) {
    const resolved = input.resolve(background);
    if (resolved && !isPinned(background, resolved)) refs.push(resolved);
  }

  return [...new Set(refs)].slice(0, 3);
}

/**
 * Bookkeeping for clips rendered on the Grok Imagine Video backend.
 *
 * A Grok render is not tied to a Google operation (the app's usual handle), so
 * each submission gets its own operation id and a small JSON sidecar next to the
 * downloaded MP4. The sidecar lets status polling and clip download survive a
 * dev-server restart without ever re-reading the auth token.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { resolveVideoCredential } from '../../mcp/grok-auth';
import { downloadGrokClip, fetchGrokClipStatus } from '../../mcp/grokVideo';
import { probeDuration } from '../../mcp/media';
import { getUploadsRoot } from './storageManager';

export type VideoBackend = 'grok' | 'gemini' | 'sandbox';

export type GrokClipRecord = {
  operationName: string;
  requestId: string;
  baseUrl: string;
  userId: string;
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  durationSeconds: number;
  createdAt: string;
  billedTo: string;
  authKind: 'api-key' | 'session';
  status: 'submitted' | 'completed' | 'failed';
  /** Measured from the downloaded file, so it reflects the real clip. */
  actualDurationSeconds?: number;
  costUsd?: number;
  fileBytes?: number;
  errorMessage?: string;
};

/**
 * Rendered clips live in the app's private data directory, not under `uploads/`,
 * because `uploads/` is served statically without an ownership check. Playback
 * goes through `/api/video-download`, which authenticates and verifies the owner.
 */
const GROK_CLIP_FOLDER = 'grok-clips';
const OPERATION_PATTERN = /^grok-clip-[a-f0-9-]{36}$/i;

const clips = new Map<string, GrokClipRecord>();

export function isGrokClipOperation(operationName: string) {
  return OPERATION_PATTERN.test(operationName);
}

export function getGrokClipDirectory() {
  const dir = path.join(process.cwd(), '.storyforge', GROK_CLIP_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getGrokClipFilePath(operationName: string) {
  if (!isGrokClipOperation(operationName)) {
    throw new Error('Invalid Grok clip operation id.');
  }
  return path.join(getGrokClipDirectory(), `${operationName}.mp4`);
}

/**
 * Authenticated URL the app's preview player can load directly. `<video src>`
 * sends the session cookie for same-origin requests, so playback needs no
 * extra plumbing in the component.
 */
export function getGrokClipDownloadUrl(operationName: string) {
  return `/api/video-download?operationName=${encodeURIComponent(operationName)}`;
}

function getGrokClipSidecarPath(operationName: string) {
  return path.join(getGrokClipDirectory(), `${operationName}.json`);
}

export function registerGrokClip(record: GrokClipRecord) {
  clips.set(record.operationName, record);
  persistGrokClip(record);
  return record;
}

function persistGrokClip(record: GrokClipRecord) {
  try {
    fs.writeFileSync(getGrokClipSidecarPath(record.operationName), JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    console.warn('[Grok Clip] Could not persist clip metadata:', error);
  }
}

export function getGrokClip(operationName: string): GrokClipRecord | null {
  const cached = clips.get(operationName);
  if (cached) {
    return cached;
  }
  if (!isGrokClipOperation(operationName)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(getGrokClipSidecarPath(operationName), 'utf8');
    const parsed = JSON.parse(raw) as GrokClipRecord;
    if (parsed?.requestId) {
      clips.set(operationName, parsed);
      return parsed;
    }
  } catch {
    // No sidecar: either the clip never got that far or it was cleared.
  }
  return null;
}

function updateGrokClip(record: GrokClipRecord, patch: Partial<GrokClipRecord>) {
  Object.assign(record, patch);
  persistGrokClip(record);
  return record;
}

/** Build the operation the render endpoints will hand back to the UI. */
export function createGrokOperationName() {
  return `grok-clip-${uuidv4()}`;
}

export type GrokClipProgress =
  | { done: false; progress: number; status: string }
  | { done: true; error?: string; record?: GrokClipRecord };

/**
 * Check a render and, once it is finished, pull the MP4 down and probe it, so a
 * `done` answer always means the player can load a real file.
 */
export async function pollGrokClip(operationName: string): Promise<GrokClipProgress> {
  const record = getGrokClip(operationName);
  if (!record) {
    return { done: true, error: 'This Grok render session was not found. Start the shot again.' };
  }

  if (record.status === 'completed' && fs.existsSync(getGrokClipFilePath(operationName))) {
    return { done: true, record };
  }

  const status = await fetchGrokClipStatus({ requestId: record.requestId, baseUrl: record.baseUrl });

  if (status.state === 'unauthorized') {
    updateGrokClip(record, { status: 'failed', errorMessage: status.detail });
    return { done: true, error: `${status.detail} ${status.hint}` };
  }

  if (status.state === 'failed') {
    updateGrokClip(record, { status: 'failed', errorMessage: status.detail });
    return { done: true, error: status.detail };
  }

  if (status.state === 'pending') {
    const progress = typeof status.progress === 'number' ? Math.round(status.progress) : 10;
    return { done: false, progress, status: `Rendering on Grok (${progress}%)` };
  }

  try {
    const target = getGrokClipFilePath(operationName);
    const { bytes } = await downloadGrokClip(status.videoUrl, target);
    const actualDurationSeconds = await probeDuration(target);
    updateGrokClip(record, {
      status: 'completed',
      costUsd: status.costUsd,
      fileBytes: bytes,
      actualDurationSeconds: actualDurationSeconds ?? record.durationSeconds,
      errorMessage: undefined,
    });
    return { done: true, record };
  } catch (error: any) {
    updateGrokClip(record, { status: 'failed', errorMessage: error?.message || 'Clip download failed.' });
    return { done: true, error: error?.message || 'Clip download failed.' };
  }
}

/**
 * Return a playable local file for an operation, downloading it first if the
 * process has just started and only the sidecar exists.
 */
export async function ensureGrokClipFile(operationName: string) {
  const filePath = getGrokClipFilePath(operationName);
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  const progress = await pollGrokClip(operationName);
  if (!progress.done || progress.error) {
    throw new Error(progress.done ? progress.error || 'Grok clip is not available.' : 'Grok clip is still rendering.');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('Grok reported success but no clip file was written.');
  }
  return filePath;
}

/**
 * Which backend a shot request should use. `THESHOW_VIDEO_BACKEND` pins one
 * explicitly (the sandbox e2e suite does), otherwise the Grok subscription wins
 * because it needs no API key, and Gemini stays as the fallback for accounts
 * that have connected a key.
 */
export type VideoBackendChoice = {
  backend: VideoBackend;
  /** True when `THESHOW_VIDEO_BACKEND` asked for this backend by name. */
  pinned: boolean;
};

export function resolveVideoBackend(hasGeminiProvider: boolean): VideoBackendChoice {
  const pinned = process.env.THESHOW_VIDEO_BACKEND?.trim().toLowerCase();
  if (pinned === 'grok' || pinned === 'gemini' || pinned === 'sandbox') {
    return { backend: pinned, pinned: true };
  }
  if (pinned && pinned !== 'auto') {
    console.warn(`[Video Backend] Ignoring unknown THESHOW_VIDEO_BACKEND="${pinned}". Use auto, grok, gemini or sandbox.`);
  }
  // A test run must never bill the subscription, even on a machine where the
  // Grok CLI is signed in. Tests that want the real backend pin it explicitly.
  if (isTestRun()) {
    return { backend: hasGeminiProvider ? 'gemini' : 'sandbox', pinned: false };
  }
  if (resolveVideoCredential().ok) {
    return { backend: 'grok', pinned: false };
  }
  return { backend: hasGeminiProvider ? 'gemini' : 'sandbox', pinned: false };
}

function isTestRun() {
  return !!process.env.VITEST || process.env.NODE_ENV === 'test';
}

export type GrokVideoAccess = {
  available: boolean;
  authKind: 'api-key' | 'session' | null;
  billedTo: string | null;
  source: string | null;
  expiresAt: string | null;
  reason: string | null;
};

/** Human-readable credential state for the account UI, without exposing the token. */
export function describeGrokVideoAccess(): GrokVideoAccess {
  const resolved = resolveVideoCredential();
  if (resolved.ok === false) {
    return {
      available: false,
      authKind: null,
      billedTo: null,
      source: null,
      expiresAt: null,
      reason: resolved.reason,
    };
  }
  return {
    available: true,
    authKind: resolved.credential.kind,
    billedTo: resolved.credential.kind === 'session' ? 'Grok subscription' : 'xAI API credits',
    source: resolved.credential.source,
    expiresAt: resolved.credential.expiresAt ?? null,
    reason: null,
  };
}

/**
 * Turn an app asset URL into something the video API accepts. Uploads live on
 * this server, so they are inlined as local paths; public URLs pass through.
 */
export function resolveAppAssetForGrok(assetUrl: string | null | undefined): string | null {
  if (!assetUrl) return null;
  const trimmed = assetUrl.trim();
  if (!trimmed) return null;
  if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const uploadsRoot = getUploadsRoot();
  const withoutQuery = trimmed.split('?')[0];

  if (withoutQuery.startsWith('/uploads/')) {
    const candidate = path.join(uploadsRoot, withoutQuery.replace('/uploads/', ''));
    const resolved = path.resolve(candidate);
    // Never let a crafted asset URL escape the uploads directory.
    if (!resolved.startsWith(path.resolve(uploadsRoot) + path.sep)) {
      return null;
    }
    return fs.existsSync(resolved) ? resolved : null;
  }

  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    return trimmed;
  }

  return null;
}

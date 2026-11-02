/**
 * Grok Imagine Video submission, polling and download.
 *
 * Shared by the MCP server (mcp/server.ts) and the StoryForge Studio API route
 * (server.ts), so both drive the same backend instead of keeping two copies of
 * the request shape. Credentials come from mcp/grok-auth.ts: an XAI_API_KEY when
 * present, otherwise the Grok CLI session token, which bills the Grok subscription.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveVideoCredential } from "./grok-auth";
import { resolveTools } from "./media";

const exec = promisify(execFile);

export type GrokClipJob = {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  model?: string;
  referenceImageUrls?: string[];
  firstFrameUrl?: string;
  /** 480p, 720p, or 1080p. Unset let the API pick a low default (~848x480). */
  resolution?: string;
};

/** Why a call stopped, so callers can decide between a retry, a hint and a hard error. */
export type GrokFailureCode =
  | "no-credential"
  | "expired-credential"
  | "rejected"
  | "submit-failed"
  | "no-request-id"
  | "failed"
  | "timeout";

export type GrokClipResult = {
  error?: string;
  code?: GrokFailureCode;
  reason?: string;
  detail?: string;
  hint?: string;
  raw?: unknown;
  fallback?: string;
  auth?: string;
  requestId?: string;
  /** Base URL the request was sent to, needed to poll it later. */
  baseUrl?: string;
  statusUrl?: string;
  billedTo?: string;
  status?: "submitted" | "completed" | "failed" | "timeout";
  videoUrl?: string;
  durationSeconds?: number;
  model?: string;
  usage?: Record<string, unknown>;
  progress?: number;
  /** Exact amount billed for this request, converted from usage.cost_in_usd_ticks. */
  costUsd?: number;
};

/** xAI reports cost in ticks where 1 USD = 10^10 ticks. */
export const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export function costUsdFromUsage(usage: Record<string, unknown> | undefined): number | undefined {
  const ticks = Number(usage?.cost_in_usd_ticks);
  return Number.isFinite(ticks) && ticks > 0 ? ticks / USD_TICKS_PER_DOLLAR : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The CLI proxy answers some failures with a full HTML error page, which must not
 * be pasted into a UI panel. Reduce a body to a short, readable reason.
 */
export function describeHttpFailure(status: number, body: string): string {
  const text = body.trim();
  if (!text.startsWith("<")) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
      const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.detail === "string" ? parsed.detail : "";
      if (message) return `HTTP ${status}: ${message}`;
    } catch {
      // Not JSON; fall through to the trimmed text form.
    }
    return `HTTP ${status}: ${text.slice(0, 300)}`;
  }

  const title = /<title>([^<]+)<\/title>/i.exec(text)?.[1]?.trim();
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = title || heading || "an HTML error page";
  return `HTTP ${status}: the Grok proxy returned ${label}. This is usually transient; retry in a few seconds.`;
}

/** Above this, a local image is re-encoded before inlining; see shrinkLocalImage. */
const INLINE_IMAGE_BUDGET_BYTES = 220 * 1024;

/**
 * Re-encode a large local image to a smaller JPEG. A 1280x720 PNG anchor frame
 * is around 700 KB, which becomes ~930 KB of base64 and exceeds the CLI proxy's
 * request body limit ("length limit exceeded"), so it has to shrink first.
 */
async function shrinkLocalImage(file: string) {
  const { ffmpeg } = await resolveTools();

  // Step down until the base64 payload actually fits the budget. A fixed scale
  // and quality was not enough: a 12-megapixel phone photo still came out around
  // 1.5 MB of base64 and the proxy rejected the request for its length. Each
  // step reduces both dimensions and quality, and gives up at a small image
  // rather than looping forever on something pathological.
  const attempts = [
    { width: 1280, quality: 4 },
    { width: 1024, quality: 6 },
    { width: 768, quality: 8 },
    { width: 512, quality: 10 },
  ];

  let lastUrl = "";
  for (const attempt of attempts) {
    const target = join(tmpdir(), `grok-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    await exec(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", file,
      "-vf", `scale='min(${attempt.width},iw)':-2`,
      "-frames:v", "1",
      "-q:v", String(attempt.quality),
      target,
    ], { maxBuffer: 16 * 1024 * 1024 });

    const shrunk = await readFile(target);
    await rm(target, { force: true });
    lastUrl = `data:image/jpeg;base64,${shrunk.toString("base64")}`;

    // Base64 is 4/3 of the byte size; keep the encoded payload under the budget.
    if (shrunk.byteLength <= INLINE_IMAGE_BUDGET_BYTES) return lastUrl;
  }

  return lastUrl;
}

/**
 * The video API takes an image as a public URL or a data URI. Accept those
 * directly and inline anything local (an anchor frame on disk) as a data URI so
 * the request stays self-contained. A video file is rejected by the API with
 * `invalid_image`, so callers must pass an extracted frame, not a clip.
 */
export async function toApiImageRef(ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  const path = trimmed.startsWith("file://") ? new URL(trimmed).pathname : trimmed;
  const buffer = await readFile(path);
  if (buffer.byteLength > INLINE_IMAGE_BUDGET_BYTES) {
    return shrinkLocalImage(path);
  }

  const ext = path.toLowerCase().match(/\.(png|jpe?g|webp|heic|heif)$/)?.[1];

  // Anything the API will not read as-is is transcoded rather than mislabelled.
  // A phone photo is often HEIC, and the old fallback here called every unknown
  // extension "image/png", which sends HEIC bytes under a PNG label: the request
  // fails or, worse, is accepted and the model sees garbage.
  if (!ext || ext === "heic" || ext === "heif") {
    return shrinkLocalImage(path);
  }

  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Submit a clip and, when asked, poll until it renders.
 *
 * Returns a plain result object rather than throwing: every failure mode here is
 * something the caller has to explain to a person (missing login, expired token,
 * rejected credential), and a typed result keeps that message intact.
 */
export async function generateGrokClip(
  job: GrokClipJob,
  opts: { waitForCompletion: boolean; timeoutSeconds: number },
): Promise<GrokClipResult> {
  const resolved = resolveVideoCredential();
  if (resolved.ok === false) {
    return {
      error: "No credential",
      code: resolved.code === "expired" ? "expired-credential" : "no-credential",
      fallback: "stub",
      reason: resolved.reason,
    };
  }
  const credential = resolved.credential;

  const body: Record<string, unknown> = {
    model: job.model || "grok-imagine-video-1.5",
    prompt: job.prompt,
    duration: job.durationSeconds || 8,
    aspect_ratio: job.aspectRatio || "16:9",
  };

  // Without this the API picks a low default (measured at 848x480) and the
  // output looks soft. It also changes the price: at 1 second, 720p billed
  // 0.14 and 1080p billed 0.25, so it is a real quality/cost dial, not a hint.
  if (job.resolution) body.resolution = job.resolution;
  if (job.firstFrameUrl) {
    body.image = { url: await toApiImageRef(job.firstFrameUrl) };
  }
  if (job.referenceImageUrls && job.referenceImageUrls.length > 0) {
    body.reference_images = await Promise.all(
      job.referenceImageUrls.map(async (url) => ({ url: await toApiImageRef(url) })),
    );
  }

  const headers = {
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
  };

  const payload = JSON.stringify(body);
  const submit = () =>
    fetch(`${credential.baseUrl}/v1/videos/generations`, {
      method: "POST",
      headers,
      body: payload,
    });

  let submitRes: Response | undefined;
  let transportError: unknown;
  // The proxy intermittently answers 502 or drops the connection; one retry is
  // enough to ride that out without making the caller wait on a real outage.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      submitRes = await submit();
      if (submitRes.status < 500) break;
    } catch (err) {
      transportError = err;
    }
    if (attempt === 0) await sleep(3000);
  }

  if (!submitRes) {
    return {
      error: "Submit failed",
      code: "submit-failed",
      detail: transportError instanceof Error ? transportError.message : String(transportError ?? "unknown transport error"),
      auth: credential.source,
    };
  }

  if (!submitRes.ok) {
    const text = await submitRes.text();
    const rejected = submitRes.status === 401 || submitRes.status === 403;
    return {
      error: `Grok Imagine Video answered ${submitRes.status}`,
      code: rejected ? "rejected" : "submit-failed",
      detail: describeHttpFailure(submitRes.status, text),
      auth: credential.source,
      hint: rejected
        ? "Credential rejected. For the session path, run `grok login` to refresh ~/.grok/auth.json."
        : submitRes.status >= 500
          ? "The render proxy was unavailable. Retry the shot in a few seconds."
          : undefined,
    };
  }

  const submitted = (await submitRes.json()) as { request_id?: string };
  const requestId = submitted.request_id;
  if (!requestId) {
    return { error: "No request_id returned", code: "no-request-id", raw: submitted, auth: credential.source };
  }

  const base = {
    requestId,
    baseUrl: credential.baseUrl,
    statusUrl: `${credential.baseUrl}/v1/videos/${requestId}`,
    auth: credential.source,
    billedTo: credential.kind === "session" ? "Grok subscription" : "xAI API credits",
  };

  if (!opts.waitForCompletion) {
    return { ...base, status: "submitted" };
  }

  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    await sleep(5000);

    let statusRes: Response;
    try {
      statusRes = await fetch(`${credential.baseUrl}/v1/videos/${requestId}`, { headers });
    } catch {
      continue;
    }
    if (!statusRes.ok) continue;

    const poll = (await statusRes.json()) as {
      status?: string;
      progress?: number;
      video?: { url?: string; duration?: number };
      model?: string;
      usage?: Record<string, unknown>;
    };
    if (typeof poll.progress === "number") lastProgress = poll.progress;

    if (poll.status === "done" || poll.status === "completed") {
      return {
        ...base,
        status: "completed",
        videoUrl: poll.video?.url,
        durationSeconds: poll.video?.duration,
        model: poll.model,
        usage: poll.usage,
        costUsd: costUsdFromUsage(poll.usage),
      };
    }
    if (poll.status === "failed" || poll.status === "error") {
      return { ...base, status: "failed", code: "failed", detail: JSON.stringify(poll) };
    }
  }

  return {
    ...base,
    status: "timeout",
    code: "timeout",
    progress: lastProgress,
    detail: `Still rendering after ${opts.timeoutSeconds}s. Poll statusUrl for the result.`,
  };
}

/**
 * Copy a finished clip onto local disk. The generation URL is short-lived, so the
 * app keeps its own copy and serves that to the player.
 */
export async function downloadGrokClip(videoUrl: string, destination: string) {
  const response = await fetch(videoUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Clip download failed: HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("Clip download returned no data.");
  }
  if (contentType && !contentType.startsWith("video/") && !contentType.startsWith("application/octet-stream")) {
    throw new Error(`Clip download returned ${contentType} instead of video.`);
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { bytes: bytes.byteLength, contentType };
}

export type GrokClipStatus =
  | { state: "pending"; progress?: number }
  | {
      state: "completed";
      videoUrl: string;
      durationSeconds?: number;
      model?: string;
      usage?: Record<string, unknown>;
      costUsd?: number;
    }
  | { state: "failed"; detail: string }
  | { state: "unauthorized"; detail: string; hint: string };

/**
 * One status check for a submitted clip. The credential is resolved fresh on
 * every call, so a token the Grok CLI refreshed is picked up mid-render.
 */
export async function fetchGrokClipStatus(input: {
  requestId: string;
  baseUrl: string;
}): Promise<GrokClipStatus> {
  const resolved = resolveVideoCredential();
  if (resolved.ok === false) {
    return {
      state: "unauthorized",
      detail: resolved.reason,
      hint: "Sign in again with `grok login --device-code`, or set XAI_API_KEY on the server.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/v1/videos/${input.requestId}`, {
      headers: { Authorization: `Bearer ${resolved.credential.token}` },
    });
  } catch (err) {
    // A transport blip is not a verdict on the render; report it as still pending.
    return { state: "pending" };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      state: "unauthorized",
      detail: `Status check rejected with HTTP ${response.status}.`,
      hint: "The Grok session token is no longer accepted. Run `grok login` on the server host.",
    };
  }
  if (!response.ok) {
    return { state: "pending" };
  }

  const body = (await response.json()) as {
    status?: string;
    progress?: number;
    video?: { url?: string; duration?: number };
    model?: string;
    usage?: Record<string, unknown>;
  };

  if (body.status === "done" || body.status === "completed") {
    if (!body.video?.url) {
      return { state: "failed", detail: "The render finished without a video URL." };
    }
    return {
      state: "completed",
      videoUrl: body.video.url,
      durationSeconds: body.video.duration,
      model: body.model,
      usage: body.usage,
      costUsd: costUsdFromUsage(body.usage),
    };
  }

  if (body.status === "failed" || body.status === "error" || body.status === "expired") {
    return { state: "failed", detail: JSON.stringify(body) };
  }

  return { state: "pending", progress: body.progress };
}

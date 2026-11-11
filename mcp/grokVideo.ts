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
  /**
   * Image to pin as the last rendered frame. With firstFrameUrl set as well the
   * shot is bookended: the model has to arrive at a frame we chose, which is what
   * makes a cut between two shots land on identical pixels instead of two
   * near-misses whose texture drift pops.
   */
  lastFrameUrl?: string;
  /** 480p, 720p, or 1080p. Unset let the API pick a low default (~848x480). */
  resolution?: string;
  /**
   * "start" pins the first frame only. An end-frame pin makes the model arrive
   * early and then hold, so end pinning is opt-in via "both".
   * Unset keeps the previous bookend behaviour when lastFrameUrl is present.
   */
  pin?: "start" | "both";
  /** Built-in voice id, such as rex. Sent as reference_audios[].voice_id. */
  voiceId?: string;
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
  /**
   * The render failed in a way that succeeded on the next identical attempt, so
   * the caller may re-chain rather than give up on the film. Retrying is left to
   * the caller because it is the one holding the film's budget and shot chain.
   */
  retryable?: boolean;
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
export const INLINE_IMAGE_BUDGET_BYTES = 220 * 1024;

/**
 * Per-image budget, in RAW JPEG bytes, when two images share one request. Only
 * a bookended shot inlines two frames.
 *
 * The proxy refuses an oversized body outright: two full-size 848x480 PNGs
 * (~600-720 KB each, so ~1.2 MB of base64) came back `Failed to read request
 * body: length limit exceeded`, while two 45-75 KB JPEGs (~155 KB of payload)
 * were accepted. Two images at the single-image budget would put ~590 KB of
 * base64 in one body, inside the range that failed. At 75 KB of raw JPEG each,
 * the pair is ~100 KB of base64 apiece and ~200 KB together: a slightly softer
 * bookend frame is worth not losing a render to a body-length error.
 *
 * NOTE the unit: this is compared against `stat` bytes, so it is raw. The pair
 * ceiling below is compared against decoded base64, so it is a different unit
 * and is named for it.
 */
export const BOOKEND_IMAGE_BUDGET_BYTES = 75 * 1024;

/**
 * Ceiling for both inlined frames together, in BASE64 bytes as they appear on
 * the wire (see dataUriBytes), because that is what the proxy's length limit
 * actually measures.
 *
 * 200 KB sits just above the ~155 KB pair that was measured working and well
 * under the ~1.2 MB pair that was rejected. It is deliberately a separate
 * number rather than a multiple of the per-image budget, so a future change to
 * one cannot silently move the other.
 */
export const BOOKEND_PAIR_BUDGET_BASE64_BYTES = 200 * 1024;

/**
 * Re-encode a large local image to a smaller JPEG. A 1280x720 PNG anchor frame
 * is around 700 KB, which becomes ~930 KB of base64 and exceeds the CLI proxy's
 * request body limit ("length limit exceeded"), so it has to shrink first.
 */
async function shrinkLocalImage(file: string, budgetBytes: number = INLINE_IMAGE_BUDGET_BYTES) {
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
    // Last resort. Only reached when nothing above fit: a bookend pair has to
    // share one body limit, and a softer still still beats a rejected render.
    { width: 384, quality: 14 },
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
    // The second half of this is a hard ceiling: a caller may tighten the budget
    // for a bookend, but never raise it past what one image may inline at all.
    if (shrunk.byteLength <= budgetBytes && shrunk.byteLength <= INLINE_IMAGE_BUDGET_BYTES) return lastUrl;
  }

  return lastUrl;
}

/**
 * The video API takes an image as a public URL or a data URI. Accept those
 * directly and inline anything local (an anchor frame on disk) as a data URI so
 * the request stays self-contained. A video file is rejected by the API with
 * `invalid_image`, so callers must pass an extracted frame, not a clip.
 */
export async function toApiImageRef(
  ref: string,
  opts: { budgetBytes?: number } = {},
): Promise<string> {
  const budget = opts.budgetBytes ?? INLINE_IMAGE_BUDGET_BYTES;
  const trimmed = ref.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  const path = trimmed.startsWith("file://") ? new URL(trimmed).pathname : trimmed;
  const buffer = await readFile(path);
  if (buffer.byteLength > budget) {
    return shrinkLocalImage(path, budget);
  }

  const ext = path.toLowerCase().match(/\.(png|jpe?g|webp|heic|heif)$/)?.[1];

  // Anything the API will not read as-is is transcoded rather than mislabelled.
  // A phone photo is often HEIC, and the old fallback here called every unknown
  // extension "image/png", which sends HEIC bytes under a PNG label: the request
  // fails or, worse, is accepted and the model sees garbage.
  if (!ext || ext === "heic" || ext === "heif") {
    return shrinkLocalImage(path, budget);
  }

  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Base64 characters carry 6 bits each, so a data URI is 4/3 of the raw bytes. */
function dataUriBytes(ref: string): number {
  const comma = ref.indexOf(",");
  if (!ref.startsWith("data:") || comma === -1) return 0;
  return Math.ceil((ref.length - comma - 1) * 0.75);
}

/**
 * Inline the bookend pair so both frames fit one request body.
 *
 * A bookend sends two images instead of one, and the proxy's body limit is a
 * property of the request, not of each image. Inlining each frame at the
 * single-image budget puts roughly 590 KB of base64 in one body, which is in the
 * range that failed with "length limit exceeded". So both are inlined at the
 * tighter pair budget, and if the pair still comes out over the combined budget
 * the larger one is re-encoded again rather than sending a request that will be
 * refused after the user has already paid attention to the estimate.
 */
async function toBookendPair(first: string, last: string): Promise<{ first: string; last: string }> {
  let firstRef = await toApiImageRef(first, { budgetBytes: BOOKEND_IMAGE_BUDGET_BYTES });
  let lastRef = await toApiImageRef(last, { budgetBytes: BOOKEND_IMAGE_BUDGET_BYTES });

  const total = dataUriBytes(firstRef) + dataUriBytes(lastRef);
  if (total <= BOOKEND_PAIR_BUDGET_BASE64_BYTES) return { first: firstRef, last: lastRef };

  // One of the two did not shrink: it was a remote URL we cannot re-encode, or
  // an already-inlined data URI. Re-shrink whatever is a local path at an even
  // smaller budget; anything unreachable stays as it is and the pair goes out at
  // whatever size it is, which is still better than two full frames.
  const tighter = Math.max(24 * 1024, Math.floor(BOOKEND_IMAGE_BUDGET_BYTES / 2));
  if (!/^https:\/\//i.test(first.trim()) && !/^data:/i.test(first.trim())) {
    firstRef = await toApiImageRef(first, { budgetBytes: tighter });
  }
  if (!/^https:\/\//i.test(last.trim()) && !/^data:/i.test(last.trim())) {
    lastRef = await toApiImageRef(last, { budgetBytes: tighter });
  }
  return { first: firstRef, last: lastRef };
}

/**
 * Is this failure worth another try, or is it the request's fault?
 *
 * The render proxy answers `internal_error` / "Video generation failed due to an
 * internal error. Please try again." and means it: measured, the identical
 * request succeeded on the next attempt. Anything else - a rejected frame, a
 * bad duration - is not going to fix itself.
 */
function isTransientRenderFailure(poll: Record<string, unknown>): boolean {
  const err = poll.error;
  const text = typeof err === "string" ? err : JSON.stringify(err ?? "");
  return /internal[_ ]error|please try again|temporarily unavailable|overloaded|rate.?limit/i.test(text);
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
  if (job.voiceId?.trim()) {
    body.reference_audios = [{ voice_id: job.voiceId.trim() }];
  }
  const sendLastFrame = Boolean(job.lastFrameUrl) && job.pin !== "start";
  if (job.firstFrameUrl && sendLastFrame && job.lastFrameUrl) {
    // Bookend: pin both ends. They share one request body, so budget the pair.
    // `image` is the first frame; there is no `first_frame` key, the API ignores
    // it (measured: 0.14 correlation, the same as an unpinned render).
    const pair = await toBookendPair(job.firstFrameUrl, job.lastFrameUrl);
    body.image = { url: pair.first };
    body.last_frame = { url: pair.last };
  } else if (job.firstFrameUrl) {
    body.image = { url: await toApiImageRef(job.firstFrameUrl) };
  } else if (sendLastFrame && job.lastFrameUrl) {
    body.last_frame = { url: await toApiImageRef(job.lastFrameUrl) };
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
      // A `last_frame` render fails intermittently and for no reason the caller
      // can see. Measured on one short 480p clip, three identical requests
      // against one picture came back failed, completed, failed - and the same
      // bookend pair failed with one frame pair and succeeded with another
      // moments later. It is not the picture: a first-frame-only render of the
      // same still succeeds every time.
      //
      // A bookend is the whole reason shots join instead of cut, so a transient
      // internal_error on it must not be reported as "this film is broken".
      // Reported back as `retryable` rather than retried here, because the
      // caller is the one holding the film's budget and the shot's chain.
      return {
        ...base,
        status: "failed",
        code: "failed",
        retryable: isTransientRenderFailure(poll),
        detail: JSON.stringify(poll),
      };
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

export type GrokStillJob = {
  prompt: string;
  /** 16:9, 9:16 or 1:1. Sent as aspect_ratio; see the fallback in generateGrokStill. */
  aspectRatio?: string;
  /** Portraits or location stills: https URLs, data URIs, or local paths. */
  referenceImageUrls?: string[];
  /**
   * The picture to EDIT, rather than a hint for a fresh one.
   *
   * Measured: `/v1/images/generations` treats a reference as a loose hint and
   * lets the prompt win outright — a portrait of a bald bearded man plus a
   * prompt describing a red-haired woman returned the woman. `/v1/images/edits`
   * with the same picture as `image` kept the man's head, beard, shirt, blazer
   * and even the sherpa collar, and added her beside him. Use a location photo
   * as the base to hold a room and a skyline across every frame.
   */
  baseImageUrl?: string;
  model?: string;
};

export type GrokStillResult = {
  error?: string;
  code?: GrokFailureCode;
  detail?: string;
  hint?: string;
  raw?: unknown;
  auth?: string;
  billedTo?: string;
  imageUrl?: string;
  /** Downloaded copy, so the still survives the short-lived generation URL. */
  localPath?: string;
  mimeType?: string;
  model?: string;
  usage?: Record<string, unknown>;
  costUsd?: number;
  /** Which body key the API accepted for the shape, so a caller knows what happened. */
  aspectRatioParam?: "aspect_ratio" | "aspectRatio" | "none";
  /** Which route produced the picture: a fresh generation or an edit of a base. */
  route?: "generations" | "edits";
  /** The render failed in a way that succeeded on the next identical attempt. */
  retryable?: boolean;
};

/**
 * Inline a set of reference images so the whole set fits one request body.
 *
 * The body limit is per request, not per image, so five portraits each inlined
 * at the single-image budget is five times the payload that a bookend already
 * showed was too much. The per-image budget therefore shrinks with the count.
 */
async function inlineReferenceSet(urls: string[]): Promise<string[]> {
  // A reference set shares one body too, so it gets the same treatment as a
  // bookend: split the single-image ceiling across the set, floor at 16 KB so a
  // long list still sends something legible rather than a thumbnail.
  const perImage = urls.length > 1
    ? Math.max(16 * 1024, Math.floor(INLINE_IMAGE_BUDGET_BYTES / urls.length))
    : INLINE_IMAGE_BUDGET_BYTES;
  return Promise.all(urls.map((url) => toApiImageRef(url, { budgetBytes: perImage })));
}

/**
 * Generate one still image. This is the cheap half of the pipeline: a still is
 * two cents where a second of video is fourteen, which is what makes boarding a
 * film as pictures before rendering it worth doing.
 *
 * Shape is the one unknown here. The video body takes `aspect_ratio`, so that is
 * tried first; if the image route rejects it the call is retried with the
 * camelCase key and then without any shape key at all, and the result says which
 * one was accepted rather than claiming a shape it did not get.
 */
export async function generateGrokStill(
  job: GrokStillJob,
  opts: {
    outputDir: string;
    /**
     * Fixed file name inside outputDir. The board passes a name derived from the
     * still prompt, so re-running a board finds the file it already paid for
     * instead of buying the same frame twice.
     */
    filename?: string;
  },
): Promise<GrokStillResult> {
  const resolved = resolveVideoCredential();
  if (resolved.ok === false) {
    return {
      error: "No credential",
      code: resolved.code === "expired" ? "expired-credential" : "no-credential",
      detail: resolved.reason,
    };
  }
  const credential = resolved.credential;

  const base: Record<string, unknown> = {
    model: job.model || "grok-imagine-image",
    prompt: job.prompt,
    n: 1,
  };
  if (job.referenceImageUrls && job.referenceImageUrls.length > 0) {
    base.reference_images = (await inlineReferenceSet(job.referenceImageUrls)).map((url) => ({ url }));
  }

  // A base image switches the route, and that switch is the whole difference
  // between a cameo and a stranger. On `generations` the reference is a hint the
  // prompt can overrule; on `edits` the picture is the subject being changed.
  // The two share a request shape (model, prompt, n, image), so only the path
  // and the image key differ.
  let route: "generations" | "edits" = "generations";
  if (job.baseImageUrl) {
    route = "edits";
    // A base picture is not a bookend: it is the ground truth for a face and a
    // room, and detail is what holds them. The bookend's 75 KB budget was set to
    // fit TWO images in one body; a base is a single image and measured fine at
    // the full inline budget (a 155 KB JPEG, ~207 KB on the wire, returned 200
    // while a 343 KB one also passed — the encoder's own width cap is what
    // actually binds, so 220 KB is the ceiling that matters).
    const baseUrl = await toApiImageRef(job.baseImageUrl, { budgetBytes: INLINE_IMAGE_BUDGET_BYTES });
    // Order is meaning, not housekeeping: the FIRST picture is the subject the
    // edit acts on, the rest are context. A portrait first ("place this man into
    // the office in the second photo") kept a face that a prompt describing him
    // could not, which is how the hero frame is built. Base alone is the plain
    // case: one picture, changed.
    const subjects = job.referenceImageUrls?.length
      ? await inlineReferenceSet(job.referenceImageUrls)
      : [];
    base.image = subjects.length > 0 ? [...subjects, baseUrl] : { url: baseUrl };
    // `reference_images` would be a second, competing copy of the same picture.
    delete base.reference_images;
  }

  const headers = {
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
  };

  // Progressive shape fallback, in the order most likely to work. Each variant
  // is one request; a variant is only dropped after the route refused the body
  // outright, never after a transport or auth failure, so a real problem is not
  // retried three times.
  const variants: Array<{ param: GrokStillResult["aspectRatioParam"]; body: Record<string, unknown> }> = [];
  if (job.aspectRatio) {
    variants.push({ param: "aspect_ratio", body: { ...base, aspect_ratio: job.aspectRatio } });
    variants.push({ param: "aspectRatio", body: { ...base, aspectRatio: job.aspectRatio } });
  }
  variants.push({ param: "none", body: { ...base } });

  let lastFailure: { status: number; text: string } | undefined;
  for (const variant of variants) {
    let response: Response;
    try {
      response = await fetch(`${credential.baseUrl}/v1/images/${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(variant.body),
      });
    } catch (err) {
      return {
        error: "Image request failed",
        code: "submit-failed",
        detail: err instanceof Error ? err.message : String(err),
        auth: credential.source,
      };
    }

    if (response.ok) {
      const payload = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string; mime_type?: string; revised_prompt?: string }>;
        model?: string;
        usage?: Record<string, unknown>;
      };
      const image = payload.data?.[0];
      if (!image?.url) {
        return {
          error: "The image route returned no image URL",
          code: "failed",
          raw: payload,
          auth: credential.source,
        };
      }

      // Keep a local copy: the generation URL is short-lived, and a board the
      // user is about to review must not evaporate while they look at it.
      const localPath = await downloadGrokStill(
        image.url,
        opts.outputDir,
        image.mime_type,
        opts.filename,
      );
      return {
        imageUrl: image.url,
        localPath,
        mimeType: image.mime_type,
        model: payload.model ?? String(variant.body.model),
        usage: payload.usage,
        costUsd: costUsdFromUsage(payload.usage),
        aspectRatioParam: variant.param,
        route,
        auth: credential.source,
        billedTo: credential.kind === "session" ? "Grok subscription" : "xAI API credits",
      };
    }

    const text = await response.text();
    lastFailure = { status: response.status, text };
    if (response.status === 401 || response.status === 403) {
      return {
        error: `Image generation was rejected (HTTP ${response.status})`,
        code: "rejected",
        detail: describeHttpFailure(response.status, text),
        auth: credential.source,
        hint: "Credential rejected. For the session path, run `grok login` to refresh ~/.grok/auth.json.",
      };
    }
    // Only a body the route refused for its shape is worth retrying without it.
    if (response.status !== 400 && response.status !== 422) break;
  }

  return {
    error: lastFailure
      ? `Image generation answered ${lastFailure.status}`
      : "Image generation failed",
    code: "submit-failed",
    detail: lastFailure ? describeHttpFailure(lastFailure.status, lastFailure.text) : undefined,
    auth: credential.source,
  };
}

/**
 * Save a generated still under a name derived from its prompt and time, and
 * return the path. Kept beside the films so a board and the film it becomes live
 * in the same place.
 */
export async function downloadGrokStill(
  imageUrl: string,
  outputDir: string,
  mimeType?: string,
  filename?: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const ext = mimeType?.includes("jpeg") || mimeType?.includes("jpg")
    ? "jpg"
    : mimeType?.includes("webp") ? "webp" : "png";
  const digest = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // A caller-supplied name is a stem, not a path: the extension comes from the
  // bytes the API said it returned, so the file is always readable as an image.
  const named = filename && !/\.[a-z0-9]{2,5}$/i.test(filename) ? `${filename}.${ext}` : filename;
  const destination = join(outputDir, named ?? `still-${digest}.${ext}`);

  if (imageUrl.startsWith("data:")) {
    const comma = imageUrl.indexOf(",");
    if (comma === -1) throw new Error("Malformed data URI for generated still.");
    await writeFile(destination, Buffer.from(imageUrl.slice(comma + 1), "base64"));
    return destination;
  }

  const response = await fetch(imageUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Still download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Still download returned no data.");
  await writeFile(destination, bytes);
  return destination;
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

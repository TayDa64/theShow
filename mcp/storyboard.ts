/**
 * Stills-first boarding: turn a shot list into the frames each shot is pinned
 * to, before a single second of video is paid for.
 *
 * Why this exists. A chained film today renders shot 1, extracts its last
 * frame, and starts shot 2 from that picture. That works on the cut but drifts
 * in between: two unpinned clips of the same scene sit around 0.20 correlation,
 * so joins pop. A bookend instead pins both ends of every shot, and consecutive
 * shots share the boundary frame — shot two's first frame IS shot one's last
 * frame — so the cut lands on identical pixels (measured: 0.998 on the pinned
 * first frame).
 *
 * Boarding makes that affordable. A still costs two cents where a second of
 * video costs fourteen, so a nine-frame board for an eight-shot film is about
 * eighteen cents against roughly nine dollars of 720p footage. The user reviews
 * the pictures first, and the expensive half only runs once they approve.
 *
 * Everything here is deliberately resumable. Stills are named from a hash of
 * their own prompt, so re-running a board finds the frames it already bought on
 * disk and buys only the missing ones.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GrokStillResult } from "./grokVideo.ts";

/**
 * Measured on a real subscription call: 200000000 ticks, i.e. two cents.
 *
 * One constant, used for both the estimate quoted before spending and the
 * fallback cost recorded after, so those two figures can never disagree.
 */
export const STILL_USD = 0.02;

/** Extensions a saved still may land under, in lookup order. */
const STILL_EXTENSIONS = ["png", "jpg", "webp"] as const;

export type BoardShotInput = {
  /** What happens in the shot. `action` is accepted too, so plan_storyboard output pastes in. */
  prompt?: string;
  action?: string;
  title?: string;
  durationSeconds?: number;
};

export type BoardFrame = {
  /** 1-based position in the film's frame sequence: shots + 1 boundaries. */
  index: number;
  /** What the still should show. */
  prompt: string;
  /** Content-addressed file stem, so a re-run recognises this frame. */
  stem: string;
};

export type BoardedShot = {
  prompt: string;
  title: string;
  durationSeconds: number;
  /** Local path of the frame this shot opens on. */
  firstFrameUrl: string;
  /** Local path of the frame this shot must arrive at. */
  lastFrameUrl: string;
  /** Which board frames those are, so a caller can see the shared boundary. */
  firstFrameIndex: number;
  lastFrameIndex: number;
};

export type BoardedFrame = {
  index: number;
  prompt: string;
  path?: string;
  /** True when the file was already on disk and cost nothing this run. */
  reused: boolean;
  costUsd?: number;
  /** Set when this frame failed to render; the rest of the board still runs. */
  error?: string;
};

export type BoardFilmResult = {
  action: "estimate-only" | "over-budget" | "boarded" | "partial";
  willSpend: boolean;
  aspectRatio: string;
  shots: BoardedShot[];
  frames: BoardedFrame[];
  estimate: {
    totalStills: number;
    newStills: number;
    reusedStills: number;
    estimatedUsd: number;
    spentUsd: number;
    perStillUsd: number;
    basis: string;
    isEstimate: boolean;
  };
  maxCostUsd?: number;
  error?: string;
  next?: string;
};

/** Resolve the prompt for a shot, whichever key the caller used. */
function shotPrompt(shot: BoardShotInput): string {
  return (shot.prompt ?? shot.action ?? "").trim();
}

/**
 * Build the frame sequence for a shot list.
 *
 * N shots need N+1 stills, not 2N: the boundary between shot k and shot k+1 is
 * one picture, used as shot k's last frame and shot k+1's first frame. That is
 * the whole point — it is what makes the cut exact — and it is also why a board
 * is cheaper than it first looks.
 */
export function planBoardFrames(opts: {
  shots: BoardShotInput[];
  aspectRatio: string;
  /** Style and continuity wording folded into every still prompt. */
  look?: string;
  /**
   * The cast, in words, repeated verbatim at the head of every still prompt.
   *
   * This is the fix for cast drift, and it is not decorative. A measured
   * three-shot board chained each still from the one before it and still put a
   * bare-headed man in frame 0, a flat cap in frame 1, and a top hat in frame 3.
   * The reference image is treated as a loose hint by the stills endpoint — a
   * night reference once produced a daylight scene — so pictures cannot hold a
   * face on their own. Words at the head of the prompt can, because they are
   * what the model reads first.
   */
  cast?: string;
  /**
   * A base picture every frame is edited from, folded into the stem so a
   * changed base re-renders rather than silently reusing frames bought against
   * the previous one.
   */
  baseImageUrl?: string;
}): BoardFrame[] {
  const { shots, aspectRatio, look, cast } = opts;
  const prompts = shots.map(shotPrompt);
  // The cast comes before the look so it wins against scene description.
  const castLock = cast?.trim() ? `THE CAST, identical in every frame: ${cast.trim()}. ` : "";
  const prefix = castLock + (look?.trim() ? `${look.trim()} ` : "");
  const shape = ` Composition matches a ${aspectRatio} frame.`;
  const still = " Single held frame, no motion blur, no text, no watermark.";

  return Array.from({ length: prompts.length + 1 }, (_, index) => {
    let prompt: string;
    if (index === 0) {
      prompt = `Opening frame of shot 1. ${prompts[0]}`;
    } else if (index === prompts.length) {
      prompt = `Closing frame of shot ${prompts.length}. ${prompts[index - 1]} The beat has just resolved.`;
    } else {
      prompt =
        `Boundary frame: the last frame of shot ${index} and the first frame of shot ${index + 1}. ` +
        `The action of shot ${index} has just resolved — ${prompts[index - 1]} ` +
        `This is where shot ${index + 1} begins — ${prompts[index]} ` +
        "Hold the same framing, light and wardrobe across the boundary.";
    }

    const full = `${prefix}${prompt}${shape}${still}`;
    const hashInput = opts.baseImageUrl ? `${full}|base:${opts.baseImageUrl}` : full;
    const stem = `board-${createHash("sha1").update(hashInput).digest("hex").slice(0, 16)}`;
    return { index, prompt: full, stem };
  });
}

/** A still already on disk for this stem, if one exists. */
export async function findExistingStill(dir: string, stem: string): Promise<string | undefined> {
  for (const ext of STILL_EXTENSIONS) {
    const candidate = join(dir, `${stem}.${ext}`);
    try {
      const info = await stat(candidate);
      if (info.size > 0) return candidate;
    } catch {
      // Not this extension; try the next.
    }
  }
  return undefined;
}

export type BoardFilmDeps = {
  /** Injected so a test never reaches the network. */
  generateStill: (
    job: { prompt: string; aspectRatio?: string; referenceImageUrls?: string[] },
    opts: { outputDir: string; filename?: string },
  ) => Promise<GrokStillResult>;
  outputDir: string;
  referenceImageUrls?: string[];
  /**
   * A location photo to edit every frame from, instead of chaining.
   *
   * Measured on a five-frame board of one office: chained frames agreed on the
   * skyline at a mean 0.36 (worst pair -0.31, i.e. unrelated), while frames all
   * edited from the same office photo agreed at 0.52. Neither locks it, and the
   * model still redraws the city a little, but editing from the source is the
   * better of the two and it is what keeps a room recognisable across a board.
   */
  baseImageUrl?: string;
};

/**
 * Estimate, gate, then render the board.
 *
 * The order is the point: the estimate is computed from the frames that are not
 * already on disk and reported before anything is billed, an estimate over
 * `maxCostUsd` refuses rather than spends, and the returned `shots` are ready to
 * paste straight into render_sequence with both frames filled in.
 */
export async function boardFilm(
  input: {
    shots: BoardShotInput[];
    aspectRatio?: string;
    look?: string;
    /** Who is in the film, in words. Repeated into every still prompt. */
    cast?: string;
    maxCostUsd?: number;
    confirm?: boolean;
  },
  deps: BoardFilmDeps,
): Promise<BoardFilmResult> {
  const aspectRatio = input.aspectRatio ?? "16:9";
  const usable = input.shots.filter((shot) => shotPrompt(shot).length > 0);

  if (usable.length === 0) {
    return {
      action: "estimate-only",
      willSpend: false,
      aspectRatio,
      shots: [],
      frames: [],
      estimate: {
        totalStills: 0,
        newStills: 0,
        reusedStills: 0,
        estimatedUsd: 0,
        spentUsd: 0,
        perStillUsd: STILL_USD,
        basis: "No shots, nothing to board.",
        isEstimate: true,
      },
      error: "No shots with a prompt or action were supplied.",
    };
  }

  const planned = planBoardFrames({
    shots: usable,
    aspectRatio,
    look: input.look,
    cast: input.cast,
    baseImageUrl: deps.baseImageUrl,
  });

  // Look before pricing: a frame already on disk is free, and a re-run of a
  // half-finished board must not charge for what it already bought.
  const existing = await Promise.all(
    planned.map(async (frame) => ({
      frame,
      path: await findExistingStill(deps.outputDir, frame.stem),
    })),
  );
  const missing = existing.filter((entry) => !entry.path);
  const estimatedUsd = Math.round(missing.length * STILL_USD * 100) / 100;
  const baseEstimate = {
    totalStills: planned.length,
    newStills: missing.length,
    reusedStills: existing.length - missing.length,
    estimatedUsd,
    spentUsd: 0,
    perStillUsd: STILL_USD,
    basis:
      `${planned.length} frames for ${usable.length} shots ` +
      `(${usable.length} + 1 shared boundaries), ${missing.length} to render at $0.02 each, ` +
      `${existing.length - missing.length} already on disk and free.`,
    isEstimate: true,
  };

  const overBudget =
    input.maxCostUsd !== undefined && estimatedUsd > input.maxCostUsd + 1e-9;

  if (!input.confirm || overBudget) {
    return {
      action: overBudget ? "over-budget" : "estimate-only",
      willSpend: false,
      aspectRatio,
      shots: [],
      frames: existing.map((entry) => ({
        index: entry.frame.index,
        prompt: entry.frame.prompt,
        path: entry.path,
        reused: Boolean(entry.path),
      })),
      estimate: baseEstimate,
      maxCostUsd: input.maxCostUsd,
      error: overBudget
        ? `The board would cost $${estimatedUsd.toFixed(2)}, over the $${
            input.maxCostUsd?.toFixed(2)
          } limit. Nothing was spent. Raise maxCostUsd or board fewer shots.`
        : undefined,
      next: overBudget
        ? "Tell the user the board is over budget and what it would cost. Do not retry with a " +
          "higher limit unless they ask for one."
        : "Show the frame count and the estimate. Call again with confirm: true only after the " +
          "user approves the board. Nothing is rendered until then.",
    };
  }

  const paths = new Map<number, string>();
  const frames: BoardedFrame[] = [];
  let spentUsd = 0;

  for (const entry of existing) {
    if (entry.path) {
      paths.set(entry.frame.index, entry.path);
      frames.push({
        index: entry.frame.index,
        prompt: entry.frame.prompt,
        path: entry.path,
        reused: true,
      });
      continue;
    }

    // Each still is generated from the one before it, as well as from any
    // character portraits. Without this the board renders every frame in
    // isolation and the cast drifts across a boundary: a measured three-shot
    // board put an old bearded lamplighter in frame 0 and a different man in a
    // flat cap in frame 1. The prompt cannot hold a face; only a reference can.
    // The board chains for the same reason the film does.
    // A base picture beats chaining, and it beats a reference too: on the edit
    // route the picture is the thing being changed, so a room and its skyline
    // survive instead of being re-imagined from a sentence. Chaining is the
    // fallback for a board with no location photo.
    const previousFrame = entry.frame.index > 0 ? paths.get(entry.frame.index - 1) : undefined;
    const refs = [
      ...(deps.referenceImageUrls ?? []),
      ...(deps.baseImageUrl ? [] : previousFrame ? [previousFrame] : []),
    ];

    const result = await deps.generateStill(
      {
        prompt: entry.frame.prompt,
        aspectRatio,
        baseImageUrl: deps.baseImageUrl,
        referenceImageUrls: refs.length > 0 ? refs : undefined,
      },
      { outputDir: deps.outputDir, filename: entry.frame.stem },
    );

    if (result.localPath) {
      paths.set(entry.frame.index, result.localPath);
      spentUsd += result.costUsd ?? STILL_USD;
      frames.push({
        index: entry.frame.index,
        prompt: entry.frame.prompt,
        path: result.localPath,
        reused: false,
        costUsd: result.costUsd,
      });
    } else {
      frames.push({
        index: entry.frame.index,
        prompt: entry.frame.prompt,
        reused: false,
        error: result.error ?? "no image returned",
      });
    }
  }

  const shots: BoardedShot[] = [];
  const gaps: number[] = [];
  usable.forEach((shot, i) => {
    const first = paths.get(i);
    const last = paths.get(i + 1);
    if (!first || !last) {
      gaps.push(i + 1);
      return;
    }
    shots.push({
      prompt: shotPrompt(shot),
      title: shot.title ?? `Shot ${i + 1}`,
      durationSeconds: shot.durationSeconds ?? 8,
      firstFrameUrl: first,
      lastFrameUrl: last,
      firstFrameIndex: i,
      lastFrameIndex: i + 1,
    });
  });

  const complete = gaps.length === 0;
  return {
    action: complete ? "boarded" : "partial",
    willSpend: true,
    aspectRatio,
    // A partial board hands back no shots at all, not the ones it managed.
    // Returning a truncated list would be pasted into render_sequence and render
    // a film that silently stops early — which is the failure this whole board
    // exists to prevent. The frames it did buy are still on disk and are reused
    // free when the board is re-run.
    shots: complete ? shots : [],
    frames,
    estimate: {
      ...baseEstimate,
      spentUsd: Math.round(spentUsd * 100) / 100,
    },
    maxCostUsd: input.maxCostUsd,
    error: complete
      ? undefined
      : `Frames missing for shots ${gaps.join(", ")}; the board is incomplete, so no shots were ` +
        "returned. Re-run board_film: frames already on disk are reused and cost nothing.",
    next: complete
      ? "Show the stills to the user for approval, then pass `shots` to render_sequence unchanged. " +
        "Consecutive shots share a boundary frame, so every cut lands on identical pixels. " +
        "Each shot is still one paid video render."
      : "Report which frames failed and re-run board_film. Do not render video from a partial board.",
  };
}

/**
 * The shot list a board produces, in the exact shape render_sequence takes.
 * Kept separate so a caller can store a board and hand it over later.
 */
export function toRenderShots(board: BoardFilmResult) {
  return board.shots.map((shot) => ({
    prompt: shot.prompt,
    title: shot.title,
    durationSeconds: shot.durationSeconds,
    firstFrameUrl: shot.firstFrameUrl,
    lastFrameUrl: shot.lastFrameUrl,
  }));
}

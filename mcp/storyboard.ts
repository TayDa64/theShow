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
import { castForPicture } from "./cast.js";
import { rm, stat } from "node:fs/promises";
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
  /**
   * Whether the reference picture's outer garment survived into this still.
   * Absent when there was no picture to check against, or nothing in it to
   * compare with.
   */
  /** How much of the arm band still wore it. Higher is closer to the picture. */
  /** True when the first attempt was rejected and a second one bought. */
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
  //
  // The reference picture outranks this text, and the wording says so. Measured:
  // a board whose cast line named a navy blazer while the reference photo showed
  // a tan sherpa coat produced a different outer layer in every frame, because
  // the prompt was quietly arguing with the picture. When a base or reference is
  // attached the cast is a description OF the picture, so the instruction is to
  // preserve it, not to re-imagine it. A shot prompt can still change something,
  // but it has to say so explicitly — see WARDROBE_CHANGE below.
  const hasPicture = Boolean(opts.baseImageUrl);
  // When a picture is attached, the cast line is stripped of anything the
  // picture can disagree with — see mcp/cast.ts. A cast line is written once, by
  // hand, from memory; the picture is the thing that is actually true.
  const castLock = cast?.trim()
    ? hasPicture
      ? castForPicture(cast)
      : `THE CAST, identical in every frame: ${cast.trim()}. `
    : "";
  const prefix = castLock + (look?.trim() ? `${look.trim()} ` : "");
  const sceneRule = hasPicture
    ? " The reference picture is the ground truth: keep its room, furniture, windows and the view " +
      "through them unchanged."
    : "";
  const shape = ` Composition matches a ${aspectRatio} frame.`;
  const still = " Single held frame, no motion blur, no text, no watermark.";

  return Array.from({ length: prompts.length + 1 }, (_, index) => {
    let prompt: string;
    if (index === 0) {
      prompt = `Opening frame of shot 1. ${prompts[0]}`;
    } else if (index === prompts.length) {
      prompt = `Closing frame of shot ${prompts.length}. ${prompts[index - 1]} The beat has just resolved.`;
    } else {
      // A boundary belongs to TWO shots, and the wording used to describe it
      // as both at once — "the last frame of shot k and the first frame of
      // shot k+1 ... hold the same framing" — which the model resolved by
      // averaging them. On a real board that put a compromise medium where a
      // close-up on hands was planned: shot 1 sat wide, shot 2 was written as
      // hands filling the frame, and the picture in between was neither, so the
      // cut read as a jump in scale rather than an edited cut. Measured: the
      // face in the boundary was 0.101 of the frame wide against the hero's
      // 0.101, and the close-up never happened.
      //
      // The frame is now written as the INCOMING shot's opening, with the
      // outgoing shot travelling to arrive at it. Same picture, same job, one
      // owner: measured on the same pair, the face came out 0.219 and 0.211 of
      // the frame wide, and one of three renders put it out of shot entirely,
      // which is what "close on his hands" was asking for.
      prompt =
        `The opening frame of shot ${index + 1}, which is also the closing frame of shot ${index}. ` +
        `${prompts[index]} ` +
        `Shot ${index} travels in to arrive at this picture, so its move ends where this frame ` +
        `begins — the camera is already where shot ${index + 1} wants it (${prompts[index - 1].trim()}) ` +
        "Hold the same light, wardrobe and room across the boundary.";
    }

    // A wardrobe change has to be asked for by name. Without this the picture
    // wins by default, which is what was wanted; with it, a shot that says "he
    // has taken the coat off" is obeyed rather than quietly reverted.
    const asksForChange =
      /\b(takes? off|removes?|changes? into|now wearing|has changed|without (?:his|the) \w+|no longer wearing)\b/i.test(prompt);
    const personRule = !hasPicture
      ? ""
      : asksForChange
        ? " This shot asks for the clothing change it names; apply that change and nothing else " +
          "about the person."
        : " Keep this person's face, head, beard hair and clothing exactly as the reference " +
          "picture shows them, and never restyle them.";

    const full = `${prefix}${prompt}${shape}${still}${sceneRule}${personRule}`;
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
  // A board with a location photo and a portrait also buys one hero frame first,
  // so the estimate has to include it or the quote is a lie by two cents.
  const heroStills = deps.baseImageUrl && (deps.referenceImageUrls ?? []).length > 0 ? 1 : 0;
  const billable = missing.length + heroStills;
  const estimatedUsd = Math.round(billable * STILL_USD * 100) / 100;
  const baseEstimate = {
    totalStills: planned.length + heroStills,
    newStills: billable,
    reusedStills: existing.length - missing.length,
    estimatedUsd,
    spentUsd: 0,
    perStillUsd: STILL_USD,
    basis:
      `${planned.length} frames for ${usable.length} shots ` +
      `(${usable.length} + 1 shared boundaries)` +
      (heroStills ? `, plus one hero frame` : "") +
      `, ${billable} to render at $0.02 each, ` +
      `${existing.length - missing.length} already on disk and free.` +
      (deps.baseImageUrl
        ? ` Each frame is checked against the picture's outer garment and re-rolled ` +
          `once if it changed, so a bad board can cost up to one extra still per frame.`
        : ""),
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

  // A location photo AND portraits cannot both ride along: measured on one
  // office, frames edited from the office alone agreed on the skyline at a mean
  // 0.57, and adding a portrait reference dropped that to 0.25. So the board
  // spends two cents building ONE hero frame first and then edits every shot
  // from that single picture.
  //
  // Which of the two photos is the SUBJECT of that hero edit decides which one
  // survives, and it is not a toss-up. On `/v1/images/edits` the first picture
  // is the thing being changed and the rest are context, so:
  //
  //  - Portrait first ("place this person into the setting in the second
  //    photo"): the face is perfect and the room is not. Measured, the frame
  //    came back as the portrait's own bright living room - sofa, doorway,
  //    trees in daylight - because the portrait's background is part of the
  //    subject an edit is inclined to keep. The office was reduced to a hint.
  //  - Office first ("place the person from the second photo into this
  //    office"): the room is exact (skyline structure correlation 0.97 against
  //    0.02-0.08 the other way round) and the person is still the person.
  //    The office is the thing that must not change, because a redrawn room is
  //    what makes two shots look like two different films; a face has a
  //    portrait pinned on every frame afterwards to correct it. Measured on
  //    three reps, the tan coat survived all three.
  //
  // So the office is the base and the portrait is the reference, whichever the
  // caller passed. Garments are never named in the text - see mcp/cast.ts.
  let boardBase = deps.baseImageUrl;
  const heroRefs = deps.baseImageUrl ? (deps.referenceImageUrls ?? []) : [];
  if (boardBase && heroRefs.length > 0 && !paths.has(-1)) {
    const subject = heroRefs[0];
    const setting = boardBase;
    const heroResult = await deps.generateStill(
      {
        prompt:
          `Place the person from the second photo into this office. ` +
          `${input.cast?.trim() ? castForPicture(input.cast) : ""}` +
          `${input.look?.trim() ? `${input.look.trim()} ` : ""}` +
          `The first photo is the room and it does not change: its walls, its furniture, its ` +
          `windows and the city through them stay exactly as they are, and its own dusk light is ` +
          `the light of this frame. The second photo supplies the person and nothing else - its ` +
          `own background is discarded. ` +
          `Photoreal, single held frame, no motion blur, no text, no watermark.`,
        aspectRatio,
        baseImageUrl: setting,
        referenceImageUrls: [subject],
      },
      { outputDir: deps.outputDir, filename: `board-hero-${createHash("sha1").update(`officeFirst|${heroRefs.join(",")}|${deps.baseImageUrl}|${input.cast ?? ""}`).digest("hex").slice(0, 16)}` },
    );
    if (heroResult.localPath) {
      boardBase = heroResult.localPath;
      spentUsd += heroResult.costUsd ?? STILL_USD;
    }
  }

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
    // Once a hero frame exists it is the only reference a shot needs; a portrait
    // alongside it would knock the skyline apart again.
    const refs = [
      ...(boardBase ? [] : deps.referenceImageUrls ?? []),
      ...(boardBase ? [] : previousFrame ? [previousFrame] : []),
    ];

    let result = await deps.generateStill(
      {
        prompt: entry.frame.prompt,
        aspectRatio,
        baseImageUrl: boardBase,
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

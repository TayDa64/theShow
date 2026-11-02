/**
 * Did a still keep the outer garment the reference picture shows?
 *
 * Why wording is not enough. The still prompt already says the picture outranks
 * the text, and measured on a real board that instruction is obeyed most of the
 * time and not all of it: six stills edited from the same hero frame with the
 * same wording produced five coats and one shearling *vest* — the coat's
 * sleeves quietly gone, the blazer underneath promoted to the outer layer. The
 * clip that shot into it then interpolated toward the vest, so by thirteen
 * seconds the film had changed clothes. A sentence cannot promise what the
 * sampler does, so the picture has to be checked.
 *
 * The check reads its target from the picture rather than from a rule about
 * colours, which matters because the next film's coat will not be tan:
 *
 *  1. Take the arm band of the reference picture — the columns either side of
 *     the torso, where a sleeve sits and a shirt does not.
 *  2. Learn that garment's dominant hue there.
 *  3. Measure how much of the NEW still's arm band still carries that hue.
 *
 * A coat that lost its sleeves leaves the arms in shirt and blazer, so the
 * coverage collapses. See `SUBSTITUTION_COVERAGE` for the measured numbers.
 *
 * Nothing here judges faces, framing or quality. It answers one question, and
 * only when the picture gives it enough garment to answer with.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTools } from "./media.ts";

const exec = promisify(execFile);

/**
 * Below this share of the arm band still wearing the reference garment's hue,
 * the layer was substituted.
 *
 * Measured over 30 stills from two boards (one shipped, one a six-repetition
 * trial): the two frames that had lost the coat's sleeves scored 0.125 and
 * 0.181, and the twenty-eight that had not scored 0.329 and up. The threshold
 * sits in that gap with room either side, and a caller still treats a miss as
 * "re-roll once", never as "this is wrong".
 */
export const SUBSTITUTION_COVERAGE = 0.26;

/** A band with less than this much garment in the reference cannot judge anything. */
const MIN_REFERENCE_SHARE = 0.12;

/** Pixels this saturated and lit are garment, not shadow or a dark room. */
const MIN_SAT = 50;
const MIN_VAL = 60;

/** Hue tolerance in OpenCV's 0..180 degrees, wide enough for a highlight. */
const HUE_TOLERANCE = 14;

/** The analysis grid. Small on purpose: this is a colour question, not detail. */
const GRID_W = 320;
const GRID_H = 180;

export type WardrobeVerdict = "kept" | "substituted" | "unknown";

export type WardrobeCheck = {
  verdict: WardrobeVerdict;
  /** Share of the new still's arm band still carrying the reference garment's hue. */
  coverage: number;
  /** Dominant hue of the reference picture's arm band, in OpenCV degrees (0..180). */
  referenceHue?: number;
  /** Why the check abstained, when it did. */
  reason?: string;
};

type Frame = { width: number; height: number; rgb: Uint8Array };

/** Decode a file to a small RGB grid, so the maths below is arithmetic on bytes. */
async function readGrid(file: string): Promise<Frame> {
  const { ffmpeg } = await resolveTools();
  const { stdout } = await exec(
    ffmpeg,
    ["-v", "error", "-i", file, "-vf", `scale=${GRID_W}:${GRID_H}`, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  const rgb = new Uint8Array(stdout as unknown as Buffer);
  if (rgb.length < GRID_W * GRID_H * 3) throw new Error(`could not decode ${file}`);
  return { width: GRID_W, height: GRID_H, rgb };
}

/**
 * The columns either side of the torso. Deliberately outside the centre: the
 * centre of a coat and the centre of a vest look identical, and it is exactly
 * the arms where the two garments part company.
 */
function armColumns(width: number): Array<[number, number]> {
  return [
    [Math.round(width * 0.13), Math.round(width * 0.29)],
    [Math.round(width * 0.71), Math.round(width * 0.87)],
  ];
}

/** Rows from below the chin to the hem: sleeves live here and the face does not. */
function armRows(height: number): [number, number] {
  return [Math.round(height * 0.46), Math.round(height * 0.82)];
}

type Hsv = { h: number; s: number; v: number };

function toHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: h / 2, s: max === 0 ? 0 : (d / max) * 255, v: max * 255 };
}

/** Every arm-band pixel of a frame, as HSV. */
function armBand(frame: Frame): Hsv[] {
  const out: Hsv[] = [];
  const [y0, y1] = armRows(frame.height);
  for (const [x0, x1] of armColumns(frame.width)) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * frame.width + x) * 3;
        out.push(toHsv(frame.rgb[i], frame.rgb[i + 1], frame.rgb[i + 2]));
      }
    }
  }
  return out;
}

/** Hue distance on a circle: 0 and 180 are the same colour. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 180 - d);
}

function isGarment(p: Hsv): boolean {
  return p.s > MIN_SAT && p.v > MIN_VAL;
}

/** Circular mean hue, so red that straddles 0 does not average to cyan. */
function dominantHue(pixels: Hsv[]): number | undefined {
  let sx = 0, sy = 0, n = 0;
  for (const p of pixels) {
    if (!isGarment(p)) continue;
    const a = (p.h * 2 * Math.PI) / 180;
    // Weight by saturation: a washed-out highlight should not vote as loudly
    // as the coat.
    const w = p.s / 255;
    sx += Math.cos(a) * w;
    sy += Math.sin(a) * w;
    n += 1;
  }
  if (n < 200) return undefined;
  const angle = Math.atan2(sy, sx);
  return ((angle * 180) / Math.PI / 2 + 180) % 180;
}

export async function checkWardrobe(
  referenceFile: string,
  stillFile: string,
): Promise<WardrobeCheck> {
  let reference: Frame, still: Frame;
  try {
    reference = await readGrid(referenceFile);
    still = await readGrid(stillFile);
  } catch (err) {
    return { verdict: "unknown", coverage: 0, reason: err instanceof Error ? err.message : String(err) };
  }

  const referenceBand = armBand(reference);
  const hue = dominantHue(referenceBand);
  if (hue === undefined) {
    return {
      verdict: "unknown",
      coverage: 0,
      reason: "the reference picture has too little garment in the arm band to learn a colour from",
    };
  }
  const referenceShare = referenceBand.filter(
    (p) => isGarment(p) && hueDistance(p.h, hue) <= HUE_TOLERANCE,
  ).length / referenceBand.length;
  if (referenceShare < MIN_REFERENCE_SHARE) {
    // E.g. a tight close-up where the arms are out of frame. Silence beats a
    // guess: a wrong re-roll costs money and can return a worse picture.
    return {
      verdict: "unknown",
      coverage: referenceShare,
      referenceHue: hue,
      reason: "the reference picture does not show enough of the outer garment to compare",
    };
  }

  const stillBand = armBand(still);
  const coverage = stillBand.filter(
    (p) => isGarment(p) && hueDistance(p.h, hue) <= HUE_TOLERANCE,
  ).length / stillBand.length;

  return {
    verdict: coverage < SUBSTITUTION_COVERAGE ? "substituted" : "kept",
    coverage,
    referenceHue: hue,
  };
}

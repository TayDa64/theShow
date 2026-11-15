/**
 * Post-generation checklist.
 *
 * Contact, fixed set size, object counts, garment state, and scale stay tier 0
 * in the weighted gate and outrank style. This checklist is the pixel-side
 * companion: a failed take is deleted and is not a pin or the next start frame.
 * Measurements are supplied by the caller. Nothing here calls a vision API.
 */

import { rm } from "node:fs/promises";
import { z } from "zod";
import { negativePhrases } from "./promptLint";

/**
 * Standing tall-adult ratios. The owner is over six feet and has no full-body
 * photo, so these bands are proportions, not a picture of a particular person.
 *
 * A typical standing adult has legs a bit under half the stature, shoulders
 * near a quarter of the stature, and a torso about as long as the legs.
 */
export const TALL_ADULT = {
  minLegToStature: 0.42,
  maxShoulderToStature: 0.30,
  minTorsoToLeg: 0.75,
  maxTorsoToLeg: 1.35,
} as const;

const placedObject = z.object({
  id: z.string(),
  room: z.string(),
  label: z.string().optional(),
});

export const TakeAdmissionSchema = z.object({
  priorObjects: z.array(placedObject).optional(),
  objects: z.array(placedObject).optional(),
  torsoPx: z.number().optional(),
  legPx: z.number().optional(),
  shoulderPx: z.number().optional(),
  staturePx: z.number().optional(),
  vocalEndSeconds: z.number().optional(),
  timedEndSeconds: z.number().optional(),
});

export type TakeReport = z.infer<typeof TakeAdmissionSchema>;

export type TakeReview =
  | { ok: true }
  | { ok: false; failures: string[] };

function roomKey(room: string) {
  return room.trim().toLowerCase();
}

export function reviewTake(report?: TakeReport, negative?: string): TakeReview {
  if (!report && !negative?.trim()) return { ok: true };
  const failures: string[] = [];
  const current = report?.objects ?? [];
  const prior = report?.priorObjects;

  if (prior) {
    const priorById = new Map(prior.map((object) => [object.id, object]));
    for (const object of current) {
      const before = priorById.get(object.id);
      if (!before) {
        failures.push(
          `Object "${object.id}" is not in the prior frame, so this still added it.`,
        );
        continue;
      }
      if (roomKey(before.room) !== roomKey(object.room)) {
        failures.push(
          `Object "${object.id}" changed rooms, from "${before.room}" to "${object.room}".`,
        );
      }
    }
  }

  for (const phrase of negativePhrases(negative)) {
    const needle = phrase.toLowerCase();
    for (const object of current) {
      const label = `${object.id} ${object.label ?? ""}`.toLowerCase();
      if (label.includes(needle)) {
        failures.push(
          `Object "${object.id}" matches a known hallucination ("${phrase}").`,
        );
      }
    }
  }

  const { torsoPx, legPx, shoulderPx, staturePx } = report ?? {};
  if (
    torsoPx !== undefined &&
    legPx !== undefined &&
    legPx > 0 &&
    torsoPx / legPx < TALL_ADULT.minTorsoToLeg
  ) {
    failures.push("Squashed torso: torso length is short for a tall adult.");
  }
  if (
    torsoPx !== undefined &&
    legPx !== undefined &&
    legPx > 0 &&
    torsoPx / legPx > TALL_ADULT.maxTorsoToLeg
  ) {
    failures.push("Shortened legs: the legs are short relative to the torso.");
  }
  if (
    legPx !== undefined &&
    staturePx !== undefined &&
    staturePx > 0 &&
    legPx / staturePx < TALL_ADULT.minLegToStature
  ) {
    failures.push("Shortened legs: leg length is short for a tall adult's stature.");
  }
  if (
    shoulderPx !== undefined &&
    staturePx !== undefined &&
    staturePx > 0 &&
    shoulderPx / staturePx > TALL_ADULT.maxShoulderToStature
  ) {
    failures.push("Widened body: the shoulders are wide for a tall adult's stature.");
  }

  if (
    report?.vocalEndSeconds !== undefined &&
    report.timedEndSeconds !== undefined &&
    report.vocalEndSeconds > report.timedEndSeconds
  ) {
    failures.push(
      `Vocal ends at ${report.vocalEndSeconds}s, past the pre-timed end of ${report.timedEndSeconds}s.`,
    );
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, failures };
}

export async function discardTake(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}

/**
 * Keep a rendered file only when the checklist passes. A failure deletes it
 * so the caller cannot pin it or chain the next shot from it.
 */
export async function acceptRenderedTake(
  path: string | undefined,
  report?: TakeReport,
  negative?: string,
): Promise<{ ok: true; path: string | undefined } | { ok: false; failures: string[] }> {
  const review = reviewTake(report, negative);
  if (review.ok) return { ok: true, path };
  await discardTake(path);
  return review;
}

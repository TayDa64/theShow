/**
 * Tiered continuity checks.
 *
 * Tier 0 is pass or fail: contact, fixed set pieces, counts, garment integrity,
 * closure, wardrobe state, scale, the exact spoken line, and voice. Any failure
 * blocks spend. Tier 1 is a weighted score and blocks only when measurements
 * are present and the score is under 0.80. Tier 2 is style and never fails a take.
 *
 * Checks that need pixels (a bbox, a solid body, an unmeasured scale mark) do
 * not pass while the vision auditor is still a stub. They block until a person
 * sets humanVisionSignOff.
 */

import {
  replayContinuity,
  type ContinuityPlan,
  type PropRecord,
  type WardrobeLayer,
} from "./continuity.ts";
import type { ContractViolation } from "./contracts.ts";

export const TIER1_PASS_SCORE = 0.8;

export const TIER1_WEIGHTS = {
  freezeRun: 0.4,
  speechCoverage: 0.3,
  joinSsim: 0.2,
  motionNatural: 0.1,
} as const;

export type VisionGate = "not-required" | "human-signed-off" | "fail-closed";

export type WeightedCheck = {
  violations: ContractViolation[];
  vision: VisionGate;
  tier1?: { score: number; pass: boolean };
  /** Non-blocking notes. Empty when there is nothing to say. */
  warnings: string[];
};

function violation(
  code: ContractViolation["code"],
  shot: number,
  message: string,
): ContractViolation {
  return { code, shot, message };
}

function layerItem(layer: WardrobeLayer) {
  return layer.item.trim();
}

function scoreTier1(plan: ContinuityPlan): { score: number; pass: boolean } | undefined {
  const metrics = plan.tier1;
  if (!metrics) return undefined;
  const score =
    metrics.freezeRun * TIER1_WEIGHTS.freezeRun +
    metrics.speechCoverage * TIER1_WEIGHTS.speechCoverage +
    metrics.joinSsim * TIER1_WEIGHTS.joinSsim +
    metrics.motionNatural * TIER1_WEIGHTS.motionNatural;
  return { score, pass: score >= TIER1_PASS_SCORE };
}

function closureWords(layer: WardrobeLayer): string[] {
  const words = [...(layer.mustNotHave ?? [])];
  if (layer.closure === "zip") words.push("button", "buttons", "buttoned");
  if (layer.closure === "buttons") words.push("zip", "zipped", "zipper");
  return words;
}

/**
 * Structural tier 0/1 checks that do not look at pixels.
 * Style notes on the plan are ignored on purpose.
 */
export function evaluateWeighted(plan: ContinuityPlan): WeightedCheck {
  const violations: ContractViolation[] = [];
  const warnings: string[] = [];
  const shots = replayContinuity(plan);
  const initialProps = (plan.props ?? []).map((prop) => ({ ...prop }));
  const pendingVision: string[] = [];

  for (const shot of shots) {
    const names = new Map<string, string[]>();
    const holders = new Map<string, PropRecord[]>();
    for (const prop of shot.propsInView) {
      const key = `${prop.locationId}::${prop.name.trim().toLowerCase()}`;
      const ids = names.get(key) ?? [];
      ids.push(prop.id);
      names.set(key, ids);
      if (!prop.holder) continue;
      const held = holders.get(prop.holder) ?? [];
      held.push(prop);
      holders.set(prop.holder, held);
    }

    for (const [key, ids] of names) {
      if (ids.length < 2) continue;
      const name = key.split("::")[1] ?? key;
      violations.push(violation(
        "count",
        shot.shot,
        `Shot ${shot.shot} has ${ids.length} of "${name}" in the same room (${ids.join(", ")}).`,
      ));
    }

    for (const [holder, held] of holders) {
      const exclusive = /hanger/i.test(holder)
        || held.some((prop) => prop.contact === "hanging" || prop.contact === "held");
      if (exclusive && held.length > 1) {
        violations.push(violation(
          "contact",
          shot.shot,
          `Shot ${shot.shot} puts ${held.map((prop) => prop.name).join(" and ")} on one holder (${holder}).`,
        ));
      }
      const holderIsCharacter = plan.characters.some(
        (character) => character.name.toLowerCase() === holder.toLowerCase(),
      );
      for (const prop of held) {
        if (holderIsCharacter && prop.contact === "hanging") {
          violations.push(violation(
            "contact",
            shot.shot,
            `Shot ${shot.shot} has ${prop.name} hanging and held by ${holder}.`,
          ));
        }
      }
    }
  }

  for (const prop of initialProps) {
    if (!prop.fixed) continue;
    for (const shot of shots) {
      if (shot.locationId && shot.locationId !== prop.locationId) continue;
      const found = shot.propsInView.find((entry) => entry.id === prop.id);
      if (!found) {
        violations.push(violation(
          "set-geometry",
          shot.shot,
          `Fixed set piece ${prop.name} is missing in shot ${shot.shot}.`,
        ));
        continue;
      }
      if (found.placement !== prop.placement) {
        violations.push(violation(
          "set-geometry",
          shot.shot,
          `Fixed set piece ${prop.name} changed place in shot ${shot.shot}.`,
        ));
      }
      if (prop.bbox && found.bbox && prop.bbox.some((value, index) => value !== found.bbox?.[index])) {
        violations.push(violation(
          "set-geometry",
          shot.shot,
          `Fixed set piece ${prop.name} changed size in shot ${shot.shot}.`,
        ));
      }
    }
  }

  for (const prop of initialProps) {
    if (prop.bbox) pendingVision.push(`set-geometry:${prop.id}`);
    if (prop.solid) pendingVision.push(`contact:${prop.id}`);
  }

  for (const event of plan.propEvents ?? []) {
    if (event.action !== "move") continue;
    const prop = initialProps.find((entry) => entry.id === event.propId);
    if (!prop?.solid) continue;
    const clearance = (plan.bodyClearance ?? []).find(
      (entry) => entry.shot === event.shot && entry.solidId === prop.id,
    );
    if (clearance && clearance.clear === false) {
      violations.push(violation(
        "contact",
        event.shot,
        `Shot ${event.shot} moves ${prop.name} while the body is still in its path.`,
      ));
    }
  }

  for (const mark of plan.scaleMarks ?? []) {
    if (mark.measuredBodyH === undefined) {
      pendingVision.push(`scale:${mark.shot}`);
      continue;
    }
    const tol = Math.abs(mark.tolPct) / 100;
    const delta = mark.bodyH === 0 ? Infinity : Math.abs(mark.measuredBodyH - mark.bodyH) / mark.bodyH;
    if (delta > tol) {
      violations.push(violation(
        "scale",
        mark.shot,
        `Shot ${mark.shot} body height ${mark.measuredBodyH}px is outside ${mark.bodyH}px ±${mark.tolPct}%.`,
      ));
    }
  }

  for (const spoken of plan.spokenLines ?? []) {
    if (!spoken.line.trim()) continue;
    const prompt = (plan.shotPrompts ?? []).find((entry) => entry.shot === spoken.shot)?.prompt;
    if (!prompt || !prompt.includes(spoken.line)) {
      violations.push(violation(
        "speech-verbatim",
        spoken.shot,
        `Shot ${spoken.shot} must speak this exact line: ${spoken.line}`,
      ));
    }
  }
  const hasSpeech = (plan.spokenLines ?? []).some((spoken) => spoken.line.trim().length > 0);
  if (hasSpeech && !plan.voiceId?.trim()) {
    violations.push(violation(
      "voice",
      plan.spokenLines?.[0]?.shot ?? 1,
      "A spoken line needs a voice id, such as rex.",
    ));
  }
  if (plan.voiceId?.trim()) {
    for (const entry of plan.shotPrompts ?? []) {
      if (entry.prompt.includes("<AUDIO_0>")) continue;
      const message =
        `Shot ${entry.shot} is voiced as ${plan.voiceId.trim()} but the prompt has no <AUDIO_0> tag.`;
      if (plan.promptStyle === "sections-v2") {
        violations.push(violation("voice", entry.shot, message));
      } else {
        warnings.push(message);
      }
    }
  }

  for (const character of plan.characters) {
    for (const layer of character.wardrobe?.layers ?? []) {
      const banned = closureWords(layer);
      if (banned.length === 0) continue;
      const names = [layerItem(layer), layer.short, layer.id.replace(/-/g, " ")].filter(
        (name): name is string => Boolean(name && name.trim()),
      );
      for (const prompt of plan.shotPrompts ?? []) {
        const hay = prompt.prompt.toLowerCase();
        for (const name of names) {
          const at = hay.indexOf(name.toLowerCase());
          if (at < 0) continue;
          const window = hay.slice(Math.max(0, at - 48), at + name.length + 48);
          for (const word of banned) {
            if (!window.includes(word.toLowerCase())) continue;
            violations.push(violation(
              "closure",
              prompt.shot,
              `Shot ${prompt.shot} uses "${word}" next to ${layerItem(layer)}.`,
            ));
          }
        }
      }
    }
  }

  for (const prompt of plan.shotPrompts ?? []) {
    if (/shrugs?/i.test(prompt.prompt) && /off (?:his|her|their) shoulders/i.test(prompt.prompt)) {
      violations.push(violation(
        "garment-integrity",
        prompt.shot,
        `Shot ${prompt.shot} shrugs a garment off both shoulders, which splits it into two pieces.`,
      ));
    }
  }

  const hasLayers = plan.characters.some((character) => (character.wardrobe?.layers.length ?? 0) > 0);
  const hasPicture = Boolean(plan.hasReferencePicture || plan.hasPortrait);
  if (hasLayers && !hasPicture) {
    violations.push(violation(
      "wardrobe-unchecked",
      1,
      "Wardrobe is in play and neither a portrait nor a base picture is attached.",
    ));
  }

  let vision: VisionGate = "not-required";
  if (pendingVision.length > 0) {
    if (plan.humanVisionSignOff) {
      vision = "human-signed-off";
    } else {
      vision = "fail-closed";
      violations.push(violation(
        "vision-unchecked",
        1,
        "Vision checking is still a stub, so this take is blocked until a person signs off. " +
          `Pending: ${pendingVision.join(", ")}.`,
      ));
    }
  }

  const tier1 = scoreTier1(plan);
  if (tier1 && !tier1.pass) {
    violations.push(violation(
      "tier1-score",
      1,
      `Tier 1 score ${tier1.score.toFixed(2)} is under ${TIER1_PASS_SCORE.toFixed(2)}.`,
    ));
  }

  return { violations, vision, warnings, ...(tier1 ? { tier1 } : {}) };
}

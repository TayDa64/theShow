/**
 * Sectioned shot prompts.
 *
 * Used only when plan_storyboard is called with promptStyle "sections-v2".
 * The default path never calls this, so an old plan stays one paragraph.
 */

import type { WardrobeLayer } from "./continuity.ts";

export const FACE_ANCHOR_SENTENCE = "Keep the face exactly as the first frame shows it.";

const PERSON_IN_SHOT =
  /\b(he|she|they|him|her|them|his|hers|their|theirs|man|woman|figure|person|child|boy|girl|guy|lady|face|head|eyes?|beard|hair|hands?|arms?|shoulders?|expression|smiles?|nods?|turns?|walks?|sits?|stands?|strides?|gestures?)\b/i;

function normalisedShotType(shotType: string | undefined): string | undefined {
  const value = shotType?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return value || undefined;
}

export function shouldAnchorFace(
  prompt: string,
  opts?: { faceAnchor?: "auto" | "off"; shotType?: string },
): boolean {
  if (opts?.faceAnchor === "off") return false;
  if (normalisedShotType(opts?.shotType) === "feet-close") return false;
  return PERSON_IN_SHOT.test(prompt);
}

export type SectionLine = {
  text: string;
  delivery?: "spoken" | "sung";
  voiceTag?: string;
};

export type SectionState = {
  worn?: string[];
  mark?: string;
  text?: string;
  door?: string;
  slots?: Record<string, string | null>;
  floorAt?: Array<{ item?: string; n?: number; text: string }>;
  held?: string;
};

export type SectionBeat = {
  framing?: string;
  shotType?: string;
  camera?: "locked" | string;
  start?: SectionState;
  end?: SectionState;
  steps?: string[];
  line?: SectionLine;
  contact?: string;
  avoid?: string[];
  audio?: string;
};

export type SectionContext = {
  layers: WardrobeLayer[];
  marks?: Record<string, string>;
  fixedSet?: string;
  voiceId?: string;
};

function ensurePeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function sentenceCase(text: string): string {
  const body = text.trim().replace(/[.]+$/, "");
  if (!body) return "";
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

function layerById(layers: WardrobeLayer[], id: string) {
  const key = id.trim().toLowerCase();
  return layers.find((layer) => layer.id.toLowerCase() === key);
}

function wearPhrase(layer: WardrobeLayer): string {
  const item = layer.item.trim();
  if ((layer.type ?? "clothing") === "footwear") return `${item} on both feet`;
  if (layer.closure === "open") return `an open ${item}`;
  // A plural name ("dark trousers") already reads as a list entry. A singular
  // garment takes an article so the list does not start mid-phrase.
  if (/s$/i.test(item) && !/ss$/i.test(item)) return item;
  return `a ${item}`;
}

function wearsSentence(ids: string[] | undefined, layers: WardrobeLayer[]): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const phrases = ids.map((id) => {
    const layer = layerById(layers, id);
    return layer ? wearPhrase(layer) : id;
  });
  return `He wears ${phrases.join("; ")}.`;
}

function doorSentence(door: string | undefined): string | undefined {
  if (!door?.trim()) return undefined;
  const value = door.trim().toLowerCase();
  if (value === "closed" || value === "shut") return "The door is shut.";
  if (value === "open") {
    return "The door is fully open, swung in against the wall at the frame's left.";
  }
  return ensurePeriod(`The door is ${door.trim()}`);
}

function hangerSentence(
  slots: Record<string, string | null> | undefined,
  layers: WardrobeLayer[],
): string | undefined {
  if (!slots) return undefined;
  const labels = Object.values(slots).map((id) => {
    if (!id) return "empty";
    return layerById(layers, id)?.item ?? id;
  });
  if (labels.length === 0) return undefined;
  return `Hangers from the door side: ${labels.join(", ")}.`;
}

function floorSentence(floorAt: SectionState["floorAt"]): string | undefined {
  const text = floorAt?.map((entry) => entry.text.trim()).filter(Boolean).join("; ");
  if (!text) return undefined;
  return `Floor: ${ensurePeriod(text)}`;
}

function positionSentence(state: SectionState | undefined, marks: Record<string, string> | undefined) {
  if (!state) return undefined;
  const written = state.text?.trim() || (state.mark ? marks?.[state.mark]?.trim() : undefined);
  if (!written) return undefined;
  return ensurePeriod(written);
}

function shotLine(beat: SectionBeat): string {
  const framing = (beat.framing ?? beat.shotType ?? "wide").trim();
  if (framing === "wide" && beat.camera === "locked") {
    return "WIDE SHOT of the whole room, locked-off camera at chest height, framed as the first frame, never moving.";
  }
  const label = framing === "wide"
    ? "WIDE SHOT"
    : framing === "medium"
      ? "MEDIUM SHOT"
      : framing === "feet-close"
        ? "CLOSE-UP of his feet"
        : "CLOSE-UP";
  if (beat.camera === "locked") {
    return `${label}, locked-off camera, framed as the first frame, never moving.`;
  }
  return `${label}.`;
}

function lineSentence(line: SectionLine | undefined, voiceId: string | undefined): string | undefined {
  const text = line?.text?.trim();
  if (!text) return undefined;
  const sung = line?.delivery === "sung";
  const verb = sung ? "sings" : "speaks";
  const manner = sung
    ? "softly and warmly, at an easy natural pace"
    : "briskly and warmly, at a natural pace";
  const quoted = text.replace(/^"|"$/g, "");
  const spoken = /[.!?,]$/.test(quoted) ? quoted : `${quoted}.`;
  const tag = line?.voiceTag?.trim() || (voiceId?.trim() ? "<AUDIO_0>" : "");
  const voice = tag ? `, in the voice from ${tag}` : "";
  return `As he moves he ${verb} once, ${manner}, never sped up${voice}: "${spoken}"`;
}

function heldSentence(state: SectionState | undefined, steps: string[] | undefined, layers: WardrobeLayer[]) {
  if (!state?.held?.trim()) return undefined;
  const holding = [...(steps ?? [])].reverse().find((step) => /\bholds?\b/i.test(step));
  if (holding) return ensurePeriod(holding);
  const layer = layerById(layers, state.held);
  const name = layer?.short?.trim() || layer?.item.trim() || state.held.trim();
  return `He holds the ${name}.`;
}

function stateSentences(
  state: SectionState | undefined,
  ctx: SectionContext,
  opts: { includeSet: boolean; steps?: string[] },
): string {
  if (!state) return "";
  const parts = [
    positionSentence(state, ctx.marks),
    wearsSentence(state.worn, ctx.layers),
    opts.includeSet ? doorSentence(state.door) : undefined,
    hangerSentence(state.slots, ctx.layers),
    opts.includeSet ? floorSentence(state.floorAt) : undefined,
    opts.includeSet && ctx.fixedSet?.trim() ? `Fixed set: ${ensurePeriod(ctx.fixedSet)}` : undefined,
    heldSentence(state, opts.steps, ctx.layers),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

/**
 * One prose prompt. At most the first avoid entry is written.
 */
export function renderSectionsV2(beat: SectionBeat, ctx: SectionContext): string {
  const steps = (beat.steps ?? []).map((step) => step.trim()).filter(Boolean);
  const actionBody = [
    steps.length > 0
      ? steps.map((step, index) => `${index + 1}) ${ensurePeriod(step)}`).join(" ")
      : "",
    lineSentence(beat.line, ctx.voiceId) ?? "",
  ].filter(Boolean).join(" ");
  const avoid = beat.avoid?.map((item) => item.trim()).filter(Boolean)[0];
  const parts = [
    shotLine(beat),
    beat.start ? `START: ${stateSentences(beat.start, ctx, { includeSet: true, steps })}` : "",
    actionBody ? `ACTION: ${actionBody}` : "",
    beat.end ? `END: ${stateSentences(beat.end, ctx, { includeSet: false, steps })}` : "",
    beat.contact?.trim() ? `CONTACT: ${sentenceCase(beat.contact)}` : "",
    avoid ? `AVOID: ${ensurePeriod(avoid)}` : "",
    beat.audio?.trim() ? `AUDIO: ${ensurePeriod(beat.audio)}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * Wardrobe layers and a per-location prop ledger.
 *
 * A single description sentence cannot say what is on top and what is hidden,
 * which is how a cast line once named a navy blazer while the reference photo
 * showed a tan coat. Layers are an ordered checklist: each garment has a place
 * in the stack, a start state records what is worn, and named events (remove,
 * put on, adjust) replay into the checklist for any later shot.
 *
 * Props are scoped to a location id, so the living-room hanger and the study
 * hanger are different objects and are never merged or deduplicated by name.
 * An unnamed prop never disappears: only an event that names a prop by id can
 * move or remove it.
 *
 * The picture is still ground truth. When the worn stack matches the reference
 * and a photo is attached, prompts do not re-describe the garments — that is
 * the measured fix in mcp/cast.ts. After a named change, the checklist is what
 * the prompt describes, and a removed garment becomes a prop at its destination.
 */

import { z } from "zod";

export const IN_REFERENCE = ["visible", "partial", "hidden"] as const;
export type InReference = (typeof IN_REFERENCE)[number];

export const LAYER_TYPES = ["clothing", "footwear"] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export const CLOSURE_TYPES = ["zip", "buttons", "open", "laced", "slip-on", "none"] as const;
export type ClosureType = (typeof CLOSURE_TYPES)[number];

export const CONTACT_KINDS = ["hanging", "resting", "held"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const WARDROBE_ACTIONS = ["remove", "putOn", "adjust"] as const;
export type WardrobeAction = (typeof WARDROBE_ACTIONS)[number];

export const PROP_ACTIONS = ["add", "move", "remove"] as const;
export type PropAction = (typeof PROP_ACTIONS)[number];

export type WardrobeLayer = {
  id: string;
  item: string;
  /** Inner to outer within this layer type. 1 is against the skin or the first shoe. */
  order: number;
  inReference: InReference;
  /**
   * Clothing and footwear stack separately, so a hidden pair of shoes can warn
   * even while a visible coat is still the outer garment.
   */
  type?: LayerType;
  /** Short name used when a prompt mentions the garment. */
  short?: string;
  /** How the garment closes. A zip must not be described as buttons. */
  closure?: ClosureType;
  /** Words that must not appear next to this garment. */
  mustNotHave?: string[];
};

export type WardrobeStartState = {
  worn: string[];
};

export type WardrobeStateImage = {
  /** Layer ids worn in this photo, in any order. */
  worn: string[];
  referenceImageUrls: string[];
};

export type CharacterWardrobe = {
  layers: WardrobeLayer[];
  startState?: WardrobeStartState;
  stateImages?: WardrobeStateImage[];
};

export type WardrobeEvent = {
  /** 1-based shot this event happens in. */
  shot: number;
  /** Character name. Required when more than one cast member has layers. */
  character?: string;
  action: WardrobeAction;
  /** Layer id. */
  layer: string;
  /** Destination prop id, or a name resolved inside the shot's location. */
  to?: string;
  note?: string;
};

export type LocationRecord = {
  id: string;
  name: string;
};

export type PropRecord = {
  id: string;
  locationId: string;
  name: string;
  /** Where it sits in that room, e.g. "on the counter, left of the laptop". */
  placement: string;
  /** A character name, or another prop's id (a hanger holding a coat). */
  holder?: string;
  /**
   * Fixed pieces keep their count, size and place. A remove or a move is a
   * set-geometry failure. Unset means the piece may change when an event names it.
   */
  fixed?: boolean;
  /** How many of this piece belong in the room. Defaults to one. */
  count?: number;
  /** x, y, w, h on the wide plate. Pixel checks still need a person or a vision pass. */
  bbox?: readonly [number, number, number, number];
  /** A solid piece must not pass through a body or another solid. */
  solid?: boolean;
  /** How it touches its holder. A hanger slot is exclusive. */
  contact?: ContactKind;
};

export type PropEvent = {
  shot: number;
  action: PropAction;
  propId: string;
  locationId?: string;
  name?: string;
  placement?: string;
  holder?: string;
};

export type CharacterContinuity = {
  name: string;
  appearance?: string;
  description?: string;
  wardrobe?: CharacterWardrobe;
};

export type WornLayer = WardrobeLayer & { worn: true };

export type StagedGarment = {
  layerId: string;
  item: string;
  character: string;
  propId: string;
  locationId: string;
  placement: string;
  holder?: string;
};

export type CharacterChecklist = {
  character: string;
  worn: WardrobeLayer[];
  outermost?: WardrobeLayer;
  staged: StagedGarment[];
  adjustments: Array<{ layerId: string; item: string; note?: string }>;
  warnings: string[];
};

export type ShotContinuity = {
  shot: number;
  locationId?: string;
  checklists: CharacterChecklist[];
  propsInView: PropRecord[];
  prompt: string;
  warnings: string[];
  /** Contract wording (invariants, steps, forbidden) folded into this shot's prompt. */
  contractPrompt?: string;
};

export type ContinuityPlan = {
  characters: CharacterContinuity[];
  locations?: LocationRecord[];
  props?: PropRecord[];
  wardrobeEvents?: WardrobeEvent[];
  propEvents?: PropEvent[];
  /** 1-based shot → location id, when a beat names the room it is in. */
  shotLocations?: Array<string | undefined>;
  shotCount: number;
  /** True when board frames will be edited from a reference picture. */
  hasReferencePicture?: boolean;
  /** Optional atomic steps for a shot; when omitted, events expand into physical actions. */
  shotSteps?: Array<{ shot: number; steps: string[] }>;
  /** Built-in voice id sent with the clip, such as rex. */
  voiceId?: string;
  /**
   * "sections-v2" requires `<AUDIO_0>` in every voiced prompt.
   * Omitted or "legacy" only warns, so an older prompt still renders.
   */
  promptStyle?: "legacy" | "sections-v2";
  /** Exact words that must appear in the shot prompt. */
  spokenLines?: Array<{ shot: number; line: string }>;
  /** Prompts that will be sent, checked against spoken lines and closure words. */
  shotPrompts?: Array<{ shot: number; prompt: string }>;
  /** Body height in pixels at a mark. Missing measurements are vision-unchecked. */
  scaleMarks?: Array<{ shot: number; bodyH: number; tolPct: number; measuredBodyH?: number }>;
  /**
   * Whether the body is clear of a solid piece before that piece moves.
   * clear: false is a contact failure. Omitting it leaves the pixel check to vision.
   */
  bodyClearance?: Array<{ shot: number; solidId: string; clear: boolean }>;
  /** A person has signed the checks the vision stub cannot run. */
  humanVisionSignOff?: boolean;
  /** A portrait is attached, even when there is no location base. */
  hasPortrait?: boolean;
  /**
   * Tier 1 measurements, each from 0 to 1. Scored when present.
   * Absent means the take has not been measured yet, not that it passed.
   */
  tier1?: {
    freezeRun: number;
    speechCoverage: number;
    joinSsim: number;
    motionNatural: number;
  };
  /** Tier 2 notes. They never fail a take. */
  styleNotes?: string[];
};

function sameWorn(a: string[], b: string[]) {
  const left = [...a].map((id) => id.trim()).filter(Boolean).sort();
  const right = [...b].map((id) => id.trim()).filter(Boolean).sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

function layerById(layers: WardrobeLayer[], id: string) {
  const key = id.trim().toLowerCase();
  return layers.find((layer) => layer.id.toLowerCase() === key);
}

function sortLayers(layers: WardrobeLayer[]) {
  return [...layers].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function layerType(layer: WardrobeLayer): LayerType {
  return layer.type ?? "clothing";
}

function defaultWorn(wardrobe: CharacterWardrobe): string[] {
  if (wardrobe.startState?.worn) return [...wardrobe.startState.worn];
  return wardrobe.layers.map((layer) => layer.id);
}

export function findStateImage(wardrobe: CharacterWardrobe, worn: string[]) {
  return (wardrobe.stateImages ?? []).find((entry) => sameWorn(entry.worn, worn));
}

/**
 * Resolve a destination against the ledger.
 *
 * An id match always wins. A name match is allowed only inside the shot's own
 * location, so "coat hanger" in the living room cannot pick up the study's
 * hanger.
 */
export function resolveProp(
  props: PropRecord[],
  dest: string,
  locationId?: string,
): PropRecord | undefined {
  const key = dest.trim().toLowerCase();
  if (!key) return undefined;
  const byId = props.find((prop) => prop.id.toLowerCase() === key);
  if (byId) return byId;
  const byName = props.filter((prop) => prop.name.trim().toLowerCase() === key);
  if (byName.length === 0) return undefined;
  if (locationId) {
    const here = byName.filter((prop) => prop.locationId === locationId);
    if (here.length === 1) return here[0];
    if (here.length > 1) return undefined;
  }
  return undefined;
}

function stagedPropId(character: string, layerId: string) {
  const slug = `${character.trim().toLowerCase()}-${layerId.trim().toLowerCase()}`
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `garment-${slug}`;
}

type CharacterRuntime = {
  name: string;
  wardrobe?: CharacterWardrobe;
  worn: Set<string>;
  adjustments: Map<string, string | undefined>;
};

function startCharacters(characters: CharacterContinuity[]): CharacterRuntime[] {
  return characters.map((character) => ({
    name: character.name,
    wardrobe: character.wardrobe,
    worn: new Set(character.wardrobe ? defaultWorn(character.wardrobe) : []),
    adjustments: new Map(),
  }));
}

function pickCharacter(runtimes: CharacterRuntime[], event: WardrobeEvent): CharacterRuntime | undefined {
  if (event.character?.trim()) {
    const key = event.character.trim().toLowerCase();
    return runtimes.find((entry) => entry.name.trim().toLowerCase() === key);
  }
  const withLayers = runtimes.filter((entry) => (entry.wardrobe?.layers.length ?? 0) > 0);
  if (withLayers.length === 1) return withLayers[0];
  if (runtimes.length === 1) return runtimes[0];
  return undefined;
}

function applyWardrobeEvent(
  runtimes: CharacterRuntime[],
  props: PropRecord[],
  event: WardrobeEvent,
  locationId: string | undefined,
  warnings: string[],
) {
  const runtime = pickCharacter(runtimes, event);
  if (!runtime) {
    warnings.push(
      `Wardrobe event on shot ${event.shot} names no character, and more than one cast member has layers.`,
    );
    return;
  }
  const wardrobe = runtime.wardrobe;
  if (!wardrobe) {
    warnings.push(
      `Wardrobe event on shot ${event.shot} targets ${runtime.name}, who has no layered wardrobe.`,
    );
    return;
  }
  const layer = layerById(wardrobe.layers, event.layer);
  if (!layer) {
    warnings.push(
      `Wardrobe event on shot ${event.shot} names unknown layer "${event.layer}" for ${runtime.name}.`,
    );
    return;
  }

  if (event.action === "remove") {
    runtime.worn.delete(layer.id);
    runtime.adjustments.delete(layer.id);
    if (event.to?.trim()) {
      const dest = resolveProp(props, event.to, locationId);
      const destLocation = dest?.locationId ?? locationId;
      if (!dest && !destLocation) {
        warnings.push(
          `Removed ${layer.item} on shot ${event.shot} but "${event.to}" is not a known prop ` +
            `and the shot has no location, so it was not staged anywhere.`,
        );
        return;
      }
      const id = dest ? stagedPropId(runtime.name, layer.id) : stagedPropId(runtime.name, layer.id);
      const placement = dest
        ? `on the ${dest.name}${dest.placement ? `, ${dest.placement}` : ""}`
        : event.to!.trim();
      const next: PropRecord = {
        id,
        locationId: destLocation ?? dest?.locationId ?? "unknown",
        name: layer.item,
        placement,
        holder: dest?.id,
      };
      const existing = props.findIndex((prop) => prop.id === id);
      if (existing >= 0) props[existing] = next;
      else props.push(next);
    }
    return;
  }

  if (event.action === "putOn") {
    runtime.worn.add(layer.id);
    if (event.note) runtime.adjustments.set(layer.id, event.note);
    else runtime.adjustments.delete(layer.id);
    const id = stagedPropId(runtime.name, layer.id);
    const leftover = props.findIndex((prop) => prop.id === id);
    if (leftover >= 0) props.splice(leftover, 1);
    return;
  }

  if (event.action === "adjust") {
    if (!runtime.worn.has(layer.id)) {
      warnings.push(
        `Adjust on shot ${event.shot} names ${layer.item}, which ${runtime.name} is not wearing.`,
      );
    }
    runtime.adjustments.set(layer.id, event.note);
  }
}

function applyPropEvent(props: PropRecord[], event: PropEvent, warnings: string[]) {
  const id = event.propId.trim();
  if (!id) {
    warnings.push(`Prop event on shot ${event.shot} has no prop id; unnamed props are left where they are.`);
    return;
  }

  if (event.action === "add") {
    if (!event.locationId?.trim() || !event.name?.trim()) {
      warnings.push(
        `Add on shot ${event.shot} for "${id}" needs a locationId and a name; the ledger was not changed.`,
      );
      return;
    }
    const next: PropRecord = {
      id,
      locationId: event.locationId.trim(),
      name: event.name.trim(),
      placement: event.placement?.trim() || "in the room",
      holder: event.holder?.trim() || undefined,
    };
    const existing = props.findIndex((prop) => prop.id === id);
    if (existing >= 0) props[existing] = next;
    else props.push(next);
    return;
  }

  const index = props.findIndex((prop) => prop.id === id);
  if (index < 0) {
    warnings.push(`Prop event on shot ${event.shot} names unknown prop "${id}"; the ledger was not changed.`);
    return;
  }

  if (event.action === "remove") {
    props.splice(index, 1);
    return;
  }

  const current = props[index];
  props[index] = {
    ...current,
    locationId: event.locationId?.trim() || current.locationId,
    name: event.name?.trim() || current.name,
    placement: event.placement?.trim() || current.placement,
    holder: event.holder !== undefined ? (event.holder.trim() || undefined) : current.holder,
  };
}

function checklistFor(
  runtime: CharacterRuntime,
  props: PropRecord[],
  warnings: string[],
): CharacterChecklist | undefined {
  const wardrobe = runtime.wardrobe;
  if (!wardrobe) return undefined;
  const worn = sortLayers(wardrobe.layers.filter((layer) => runtime.worn.has(layer.id)));
  const outermost = sortLayers(worn.filter((layer) => layerType(layer) === "clothing")).at(-1);
  const staged: StagedGarment[] = props
    .filter((prop) => wardrobe.layers.some((layer) => stagedPropId(runtime.name, layer.id) === prop.id))
    .map((prop) => {
      const layer = wardrobe.layers.find((entry) => stagedPropId(runtime.name, entry.id) === prop.id);
      return {
        layerId: layer?.id ?? prop.id,
        item: prop.name,
        character: runtime.name,
        propId: prop.id,
        locationId: prop.locationId,
        placement: prop.placement,
        holder: prop.holder,
      };
    });

  const list: CharacterChecklist = {
    character: runtime.name,
    worn,
    outermost,
    staged,
    adjustments: [...runtime.adjustments.entries()].map(([layerId, note]) => ({
      layerId,
      item: layerById(wardrobe.layers, layerId)?.item ?? layerId,
      note,
    })),
    warnings: [],
  };

  const photo = findStateImage(wardrobe, worn.map((layer) => layer.id));
  const hasPhoto = Boolean(photo?.referenceImageUrls.some((url) => url.trim()));
  if (!hasPhoto) {
    const groupOutermost = new Map<LayerType, WardrobeLayer>();
    for (const type of LAYER_TYPES) {
      const top = sortLayers(worn.filter((layer) => layerType(layer) === type)).at(-1);
      if (top) groupOutermost.set(type, top);
    }
    for (const [type, top] of groupOutermost) {
      if (top.inReference !== "partial" && top.inReference !== "hidden") continue;
      const how = top.inReference === "partial" ? "only in part" : "not at all";
      const warning = type === "clothing"
        ? `After this change, ${runtime.name}'s outermost layer is ${top.item}, but the ` +
          `reference picture shows it ${how} and there is no photo for this state. ` +
          `The model will have to guess the rest of its appearance.`
        : `${runtime.name}'s ${top.item} (${type}) are shown ${how} in the reference picture, ` +
          `and there is no photo for this state. The model will have to guess their appearance.`;
      list.warnings.push(warning);
      warnings.push(warning);
    }
  }

  return list;
}

function locationName(locations: LocationRecord[] | undefined, locationId?: string) {
  if (!locationId) return undefined;
  return locations?.find((entry) => entry.id === locationId)?.name ?? locationId;
}

function describeWorn(checklist: CharacterChecklist) {
  if (checklist.worn.length === 0) {
    return `${checklist.character} is wearing none of the tracked layers`;
  }
  const names = checklist.worn.map((layer, index) => {
    const tail = checklist.outermost && layer.id === checklist.outermost.id && checklist.worn.length > 1
      ? ` (now outermost)`
      : "";
    return `${index === 0 ? "" : ""}${layer.item}${tail}`;
  });
  const joined = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${checklist.character} is wearing ${joined}`;
}

function describeChange(event: WardrobeEvent, character: string, layerItem: string) {
  if (event.action === "remove") {
    return `${character} takes off the ${layerItem}`;
  }
  if (event.action === "putOn") {
    return `${character} puts on the ${layerItem}`;
  }
  const note = event.note?.trim() ? `: ${event.note.trim()}` : "";
  return `${character} adjusts the ${layerItem}${note}`;
}

function setDressingLine(props: PropRecord[], locationId: string | undefined, locations?: LocationRecord[]) {
  if (!locationId) return "";
  const inView = props.filter((prop) => prop.locationId === locationId);
  if (inView.length === 0) return "";
  const room = locationName(locations, locationId) ?? locationId;
  const items = inView.map((prop) => {
    const holderProp = prop.holder ? props.find((entry) => entry.id === prop.holder) : undefined;
    const alreadyNamesHolder = holderProp
      ? prop.placement.toLowerCase().includes(holderProp.name.toLowerCase())
      : false;
    const heldBy = holderProp && !alreadyNamesHolder
      ? `, on the ${holderProp.name}`
      : !holderProp && prop.holder
        ? `, held by ${prop.holder}`
        : "";
    return `${prop.name}${prop.placement ? `, ${prop.placement}` : ""}${heldBy}`;
  });
  return `Fixed set dressing in the ${room}: ${items.join("; ")}.`;
}

function wardrobePrompt(opts: {
  checklists: CharacterChecklist[];
  eventsThisShot: WardrobeEvent[];
  runtimes: CharacterRuntime[];
  hasReferencePicture?: boolean;
  startWorn: Map<string, string[]>;
}) {
  const parts: string[] = [];
  const named = new Set<string>();

  for (const event of opts.eventsThisShot) {
    const runtime = pickCharacter(opts.runtimes, event);
    const item = runtime?.wardrobe
      ? (layerById(runtime.wardrobe.layers, event.layer)?.item ?? event.layer)
      : event.layer;
    const who = runtime?.name ?? event.character ?? "the character";
    parts.push(describeChange(event, who, item) + ".");
    named.add(who.toLowerCase());
  }

  for (const checklist of opts.checklists) {
    const start = opts.startWorn.get(checklist.character.toLowerCase()) ?? [];
    const now = checklist.worn.map((layer) => layer.id);
    const changed = !sameWorn(start, now) || checklist.adjustments.length > 0 || named.has(checklist.character.toLowerCase());
    if (!changed && opts.hasReferencePicture) {
      // The picture already shows this stack; naming the garments would argue
      // with it, which is the failure mcp/cast.ts exists to prevent.
      continue;
    }
    if (!changed && !opts.hasReferencePicture) {
      parts.push(`${describeWorn(checklist)}.`);
      continue;
    }
    parts.push(`${describeWorn(checklist)}.`);
    for (const staged of checklist.staged) {
      const verb = /\b(shoes|pants|trousers|glasses)\b/i.test(staged.item) ? "are" : "is";
      parts.push(`The ${staged.item} ${verb} ${staged.placement}.`);
    }
    for (const adjustment of checklist.adjustments) {
      if (!adjustment.note) continue;
      const alreadyNamed = opts.eventsThisShot.some(
        (event) => event.action === "adjust" && event.layer === adjustment.layerId && event.note === adjustment.note,
      );
      if (alreadyNamed) continue;
      parts.push(`${checklist.character} ${adjustment.note}.`);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Replay wardrobe and prop events shot by shot and build each shot's checklist,
 * the props in view at that location, prompt wording, and any warnings.
 */
export function replayContinuity(plan: ContinuityPlan): ShotContinuity[] {
  const runtimes = startCharacters(plan.characters);
  const props: PropRecord[] = (plan.props ?? []).map((prop) => ({ ...prop }));
  const startWorn = new Map(
    runtimes.map((runtime) => [
      runtime.name.toLowerCase(),
      runtime.wardrobe ? defaultWorn(runtime.wardrobe) : [],
    ]),
  );
  const shots: ShotContinuity[] = [];

  for (let index = 1; index <= plan.shotCount; index += 1) {
    const warnings: string[] = [];
    const locationId = plan.shotLocations?.[index - 1];
    const wardrobeEvents = (plan.wardrobeEvents ?? []).filter((event) => event.shot === index);
    const propEvents = (plan.propEvents ?? []).filter((event) => event.shot === index);

    for (const event of propEvents) applyPropEvent(props, event, warnings);
    for (const event of wardrobeEvents) applyWardrobeEvent(runtimes, props, event, locationId, warnings);

    const checklists = runtimes
      .map((runtime) => checklistFor(runtime, props, warnings))
      .filter((entry): entry is CharacterChecklist => Boolean(entry));

    const propsInView = locationId
      ? props.filter((prop) => prop.locationId === locationId).map((prop) => ({ ...prop }))
      : [];

    const wardrobeText = wardrobePrompt({
      checklists,
      eventsThisShot: wardrobeEvents,
      runtimes,
      hasReferencePicture: plan.hasReferencePicture,
      startWorn,
    });
    const dressing = setDressingLine(props, locationId, plan.locations);
    const prompt = [wardrobeText, dressing].filter(Boolean).join(" ").trim();

    shots.push({
      shot: index,
      locationId,
      checklists,
      propsInView,
      prompt,
      warnings: [...warnings, ...checklists.flatMap((entry) => entry.warnings)].filter(
        (value, i, all) => all.indexOf(value) === i,
      ),
    });
  }

  return shots;
}

export function annotateAction(action: string, continuityPrompt: string) {
  const extra = continuityPrompt.trim();
  if (!extra) return action;
  const body = action.trim();
  if (!body) return extra;
  if (body.includes(extra)) return body;
  return `${body} ${extra}`.replace(/\s+/g, " ").trim();
}

/**
 * Post-render check: compare sampled frames against the ledger and flag
 * vanished, appeared, or moved props with frame numbers.
 *
 * This is a stub. It must not be wired to a vision or image API: those calls
 * cost money and the cost per shot has not been measured.
 */
export type ContinuityAuditFinding = {
  kind: "vanished" | "appeared" | "moved";
  propId: string;
  locationId: string;
  name: string;
  frameNumber: number;
  note: string;
  thumbnailPath?: string;
};

export type ContinuityAuditInput = {
  shotIndex: number;
  framePaths: string[];
  expected: ShotContinuity;
  /** Optional per-shot contract a later vision implementation should check frames against. */
  contract?: {
    shot: number;
    steps: string[];
    invariants: string[];
    forbidden: string[];
  };
};

export type ContinuityAuditor = {
  auditShot(input: ContinuityAuditInput): Promise<ContinuityAuditFinding[]>;
};

/** Shape a real or recorded auditor must return. The default auditor never produces one. */
export const ContinuityAuditFindingSchema = z.object({
  kind: z.enum(["vanished", "appeared", "moved"]),
  propId: z.string().min(1),
  locationId: z.string().min(1),
  name: z.string().min(1),
  frameNumber: z.number().int().nonnegative(),
  note: z.string(),
  thumbnailPath: z.string().optional(),
});

export const CONTINUITY_AUDIT_UNIMPLEMENTED =
  "Post-render continuity audit is not implemented. It would sample frames from a " +
  "finished shot and compare them to the prop ledger with a vision call, flagging " +
  "props that vanished, appeared, or moved, with frame numbers and thumbnails. " +
  "The cost of that vision pass per shot has not been measured, so this function " +
  "refuses to run rather than spend anything.";

export function unimplementedContinuityAuditor(): ContinuityAuditor {
  return {
    async auditShot() {
      throw new Error(CONTINUITY_AUDIT_UNIMPLEMENTED);
    },
  };
}

export function parseWardrobe(raw: unknown): CharacterWardrobe | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<CharacterWardrobe>;
  if (!Array.isArray(value.layers)) return undefined;
  const layers: WardrobeLayer[] = [];
  for (const entry of value.layers) {
    if (!entry || typeof entry !== "object") continue;
    const layer = entry as Partial<WardrobeLayer>;
    if (typeof layer.id !== "string" || !layer.id.trim()) continue;
    if (typeof layer.item !== "string" || !layer.item.trim()) continue;
    if (typeof layer.order !== "number" || !Number.isFinite(layer.order)) continue;
    const inReference = IN_REFERENCE.includes(layer.inReference as InReference)
      ? (layer.inReference as InReference)
      : "visible";
    const type = LAYER_TYPES.includes(layer.type as LayerType)
      ? (layer.type as LayerType)
      : undefined;
    const closure = CLOSURE_TYPES.includes(layer.closure as ClosureType)
      ? (layer.closure as ClosureType)
      : undefined;
    const mustNotHave = Array.isArray(layer.mustNotHave)
      ? layer.mustNotHave.filter((word): word is string => typeof word === "string" && word.trim().length > 0)
      : undefined;
    layers.push({
      id: layer.id.trim(),
      item: layer.item.trim(),
      order: layer.order,
      inReference,
      ...(type ? { type } : {}),
      ...(typeof layer.short === "string" && layer.short.trim() ? { short: layer.short.trim() } : {}),
      ...(closure ? { closure } : {}),
      ...(mustNotHave && mustNotHave.length > 0 ? { mustNotHave } : {}),
    });
  }
  if (layers.length === 0) return undefined;

  const worn = Array.isArray(value.startState?.worn)
    ? value.startState!.worn.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : layers.map((layer) => layer.id);

  const stateImages = Array.isArray(value.stateImages)
    ? value.stateImages.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const wornIds = Array.isArray(entry.worn)
          ? entry.worn.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
          : [];
        const urls = Array.isArray(entry.referenceImageUrls)
          ? entry.referenceImageUrls.filter((url): url is string => typeof url === "string")
          : [];
        return [{ worn: wornIds, referenceImageUrls: urls }];
      })
    : undefined;

  return {
    layers,
    startState: { worn },
    ...(stateImages && stateImages.length > 0 ? { stateImages } : {}),
  };
}

export function characterFromRecord(record: {
  name: string;
  appearance?: string;
  description?: string;
  wardrobe?: CharacterWardrobe;
}): CharacterContinuity {
  return {
    name: record.name,
    appearance: record.appearance,
    description: record.description,
    wardrobe: record.wardrobe,
  };
}

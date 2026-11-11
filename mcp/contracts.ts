/**
 * Per-shot state-file contracts, derived from the continuity ledger.
 *
 * A checklist that only reaches the video model as advice is how a coat came
 * off twice, a blazer vanished and returned, and three street shoes appeared
 * in one frame. Each shot now carries a contract: the state that must hold at
 * the start, the atomic steps in between, the state that must hold at the end,
 * invariants that hold for the whole shot, and things that must not appear.
 *
 * Validation is cheap and offline. It refuses more than three steps, a garment
 * that is both worn and hanging, a count that invents a second coat or a third
 * shoe, and a shot whose start does not match the previous shot's end.
 */

import {
  replayContinuity,
  resolveProp,
  unimplementedContinuityAuditor,
  type ContinuityAuditor,
  type ContinuityPlan,
  type PropEvent,
  type PropRecord,
  type ShotContinuity,
  type WardrobeEvent,
  type WardrobeLayer,
} from "./continuity.ts";
import { evaluateWeighted, type VisionGate } from "./weighted.ts";

export const MAX_STEPS_PER_SHOT = 3;

export const RENDER_BLOCKED_BY_CONTRACT =
  "render_sequence refused to start because the shot contracts failed validation. " +
  "Pass overrideValidation: true to proceed anyway.";

export const RENDER_UNCHECKED =
  "render_sequence refused to start because no continuity ledger or shot contracts were provided. " +
  "A plan with nothing to check is unchecked, and unchecked does not spend.";

export type ShotState = {
  worn: string[];
  holders: Record<string, string>;
  counts: Record<string, number>;
};

export type ShotContract = {
  shot: number;
  requires: ShotState;
  steps: string[];
  ensures: ShotState;
  invariants: string[];
  forbidden: string[];
  /** Layer ids that are footwear, so a pair must count as 2. */
  footwear?: string[];
};

export type ContractViolation = {
  code:
    | "too-many-steps"
    | "requires-mismatch"
    | "worn-and-held"
    | "duplicate-garment"
    | "footwear-count"
    | "ledger-mismatch"
    | "unchecked"
    | "count"
    | "contact"
    | "set-geometry"
    | "garment-integrity"
    | "wardrobe-unchecked"
    | "scale"
    | "speech-verbatim"
    | "voice"
    | "vision-unchecked"
    | "closure"
    | "tier1-score";
  shot: number;
  message: string;
  suggestSplit?: boolean;
};

export type ContractValidation = {
  ok: boolean;
  violations: ContractViolation[];
};

export type RenderGateInput = {
  plan?: ContinuityPlan;
  contracts?: ShotContract[];
  overrideValidation?: boolean;
};

export type GateStatus = "pass" | "fail" | "unchecked" | "override";

export type RenderGateResult = {
  ok: boolean;
  blocked: boolean;
  status: GateStatus;
  violations: ContractViolation[];
  message?: string;
  /** Tier 0 failed when status is fail, unchecked, or override. */
  tier0: "pass" | "fail";
  /** Present only when the plan carried tier 1 measurements. */
  tier1?: { score: number; pass: boolean };
  /** Style notes never change this. */
  tier2: "style-only";
  vision: VisionGate;
  /** Present only when a check had something to say and did not block. */
  warnings?: string[];
};

function layerType(layer: WardrobeLayer) {
  return layer.type ?? "clothing";
}

function allLayers(plan: ContinuityPlan): WardrobeLayer[] {
  return plan.characters.flatMap((character) => character.wardrobe?.layers ?? []);
}

function findLayer(plan: ContinuityPlan, id: string) {
  const key = id.trim().toLowerCase();
  return allLayers(plan).find((layer) => layer.id.toLowerCase() === key);
}

function sortIds(ids: string[]) {
  return [...ids].map((id) => id.trim()).filter(Boolean).sort();
}

function sameIds(a: string[], b: string[]) {
  const left = sortIds(a);
  const right = sortIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? "") !== (b[key] ?? "")) return false;
  }
  return true;
}

function sameCounts(a: Record<string, number> | undefined, b: Record<string, number> | undefined) {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? 0) !== (right[key] ?? 0)) return false;
  }
  return true;
}

export function sameShotState(a: ShotState, b: ShotState) {
  return sameIds(a.worn, b.worn) && sameRecord(a.holders, b.holders) && sameCounts(a.counts, b.counts);
}

function sameTextList(a: string[] | undefined, b: string[] | undefined) {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isHangerDest(to: string | undefined, plan: ContinuityPlan) {
  if (!to?.trim()) return false;
  if (/hanger/i.test(to)) return true;
  const prop = resolveProp(plan.props ?? [], to);
  return Boolean(prop && /hanger/i.test(`${prop.id} ${prop.name}`));
}

function hangerLike(prop: PropRecord) {
  return /hanger/i.test(`${prop.id} ${prop.name}`);
}

function nounFor(layer: WardrobeLayer) {
  return layer.id.replace(/-/g, " ");
}

function singularNoun(layer: WardrobeLayer) {
  // "street shoes" and a layer whose id is just "shoes" both become "shoe".
  return nounFor(layer).replace(/shoes$/i, "shoe");
}

export function expandWardrobeEventToSteps(event: WardrobeEvent, plan: ContinuityPlan): string[] {
  const layer = findLayer(plan, event.layer);
  if (!layer) return [`${event.action} ${event.layer}`];
  const item = layer.item;
  const type = layerType(layer);

  if (event.action === "adjust") {
    return [event.note?.trim() || `adjusts ${item}`];
  }
  if (event.action === "putOn") {
    return [type === "footwear" ? `puts on both ${item}` : `puts on ${item}`];
  }

  if (type === "footwear") {
    return [`removes both ${item}`];
  }

  const steps: string[] = [];
  const alreadyOpen = layer.closure === "open" || layer.closure === "slip-on" || layer.closure === "none";
  if (!alreadyOpen && /\b(coat|jacket|blazer)\b/i.test(`${layer.id} ${item}`)) {
    steps.push(`unbuttons ${item}`);
  }
  steps.push(`removes ${item}`);
  if (isHangerDest(event.to, plan)) {
    // The hanger stays on the rail. Lifting it off is where a second hanger appears.
    steps.push(`hangs ${item} on the empty hanger; the hanger stays on the rail`);
  }
  return steps;
}

function expandPropEventToSteps(event: PropEvent, props: PropRecord[]): string[] {
  const current = props.find((prop) => prop.id === event.propId);
  const name = event.name ?? current?.name ?? event.propId;
  const holder = event.holder ?? "";
  if (event.action === "move" && /hanger/i.test(`${holder} ${event.placement ?? ""}`)) {
    return [`hangs ${name} on the empty hanger; the hanger stays on the rail`];
  }
  if (event.action === "move") return [`moves ${name}`];
  if (event.action === "add") return [`adds ${name}`];
  if (event.action === "remove") return [`removes ${name} from the set`];
  return [];
}

function stepsForShot(plan: ContinuityPlan, shot: number): string[] {
  const named = (plan.shotSteps ?? []).find((entry) => entry.shot === shot);
  if (named) return [...named.steps];

  const wardrobe = (plan.wardrobeEvents ?? []).filter((event) => event.shot === shot);
  const props = (plan.propEvents ?? []).filter((event) => event.shot === shot);
  return [
    ...wardrobe.flatMap((event) => expandWardrobeEventToSteps(event, plan)),
    ...props.flatMap((event) => expandPropEventToSteps(event, plan.props ?? [])),
  ];
}

function holdersFromProps(props: PropRecord[]): Record<string, string> {
  const holders: Record<string, string> = {};
  for (const prop of props) {
    const held = props.filter((other) => other.holder === prop.id);
    if (held.length === 0 && !hangerLike(prop)) continue;
    holders[prop.id] = held.length === 0
      ? `empty, ${prop.placement}`
      : `${prop.placement}, holding ${held.map((entry) => entry.name).join(" and ")}`;
  }
  return holders;
}

function wornFrom(snapshot: ShotContinuity | undefined) {
  const worn = (snapshot?.checklists ?? []).flatMap((list) => list.worn);
  const clothing = worn
    .filter((layer) => layerType(layer) === "clothing")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const shoes = worn
    .filter((layer) => layerType(layer) === "footwear")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return [...clothing, ...shoes].map((layer) => layer.id);
}

function stagedLayerIds(snapshot: ShotContinuity | undefined) {
  return (snapshot?.checklists ?? []).flatMap((list) => list.staged.map((item) => item.layerId));
}

function countsFor(
  plan: ContinuityPlan,
  snapshot: ShotContinuity | undefined,
  worn: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const staged = new Set(stagedLayerIds(snapshot));
  const props = snapshot?.propsInView ?? [];
  for (const layer of allLayers(plan)) {
    const unit = layerType(layer) === "footwear" ? 2 : 1;
    const isWorn = worn.includes(layer.id);
    const isStaged = staged.has(layer.id);
    const matchingProps = props.filter((prop) => {
      if (prop.id.startsWith("garment-")) return false;
      return prop.id === layer.id || prop.name.trim().toLowerCase() === layer.item.trim().toLowerCase();
    });
    counts[layer.id] =
      (isWorn ? unit : 0) +
      (isStaged ? unit : 0) +
      (matchingProps.length > 0 && !isWorn && !isStaged ? unit : 0);
  }
  return counts;
}

function stateFromSnapshot(plan: ContinuityPlan, snapshot: ShotContinuity | undefined): ShotState {
  const worn = wornFrom(snapshot);
  return {
    worn,
    holders: holdersFromProps(snapshot?.propsInView ?? []),
    counts: countsFor(plan, snapshot, worn),
  };
}

function initialSnapshot(plan: ContinuityPlan): ShotContinuity | undefined {
  const [opening] = replayContinuity({
    ...plan,
    shotCount: Math.max(1, plan.shotCount),
    wardrobeEvents: [],
    propEvents: [],
  });
  return opening;
}

function itemsInPlay(requires: ShotState, ensures: ShotState, layers: WardrobeLayer[]) {
  const ids = new Set([...requires.worn, ...ensures.worn]);
  for (const layer of layers) {
    if ((requires.counts[layer.id] ?? 0) > 0 || (ensures.counts[layer.id] ?? 0) > 0) {
      ids.add(layer.id);
    }
  }
  return layers.filter((layer) => ids.has(layer.id));
}

function deriveInvariants(plan: ContinuityPlan, requires: ShotState, ensures: ShotState) {
  const layers = allLayers(plan);
  const unchanged = requires.worn.filter((id) => ensures.worn.includes(id));
  const invariants: string[] = [];

  for (const id of unchanged) {
    const layer = findLayer(plan, id);
    if (!layer) continue;
    invariants.push(`${layer.item} worn the whole shot`);
    if (layerType(layer) === "footwear") {
      invariants.push(`exactly 2 ${layer.item}, on feet`);
    }
  }

  for (const layer of itemsInPlay(requires, ensures, layers)) {
    if (layerType(layer) === "footwear") {
      if (!unchanged.includes(layer.id)) {
        invariants.push(`exactly 2 ${layer.item} in frame`);
      }
    } else {
      invariants.push(`exactly one ${layer.item} in frame`);
    }
  }

  return invariants;
}

function deriveForbidden(plan: ContinuityPlan, requires: ShotState, ensures: ShotState) {
  const layers = allLayers(plan);
  const worn = new Set([...requires.worn, ...ensures.worn]);
  const forbidden: string[] = [];
  const hangerPresent = Object.keys(requires.holders).concat(Object.keys(ensures.holders))
    .some((id) => /hanger/i.test(id));

  for (const layer of itemsInPlay(requires, ensures, layers)) {
    if (layerType(layer) === "footwear") {
      forbidden.push(`a third ${singularNoun(layer)}`);
      forbidden.push(`only one ${singularNoun(layer)}`);
    } else {
      forbidden.push(`second ${nounFor(layer)}`);
      if (hangerPresent && worn.has(layer.id)) {
        forbidden.push(`${nounFor(layer)} on hanger`);
      }
    }
  }

  return forbidden;
}

/**
 * Replay the ledger and build one contract per shot, including auto-derived
 * invariants, counts, and forbidden items.
 */
export function deriveContracts(plan: ContinuityPlan): ShotContract[] {
  const start = initialSnapshot(plan);
  const ends = replayContinuity(plan);
  const footwear = allLayers(plan)
    .filter((layer) => layerType(layer) === "footwear")
    .map((layer) => layer.id);

  return ends.map((snapshot, index) => {
    const requires = stateFromSnapshot(plan, index === 0 ? start : ends[index - 1]);
    const ensures = stateFromSnapshot(plan, snapshot);
    return {
      shot: snapshot.shot,
      requires,
      steps: stepsForShot(plan, snapshot.shot),
      ensures,
      invariants: deriveInvariants(plan, requires, ensures),
      forbidden: deriveForbidden(plan, requires, ensures),
      ...(footwear.length > 0 ? { footwear } : {}),
    };
  });
}

function heldNames(holders: Record<string, string>) {
  const names: string[] = [];
  for (const value of Object.values(holders)) {
    const match = value.match(/holding (.+)$/i);
    if (!match) continue;
    names.push(...match[1].split(/ and /i).map((part) => part.trim().toLowerCase()));
  }
  return names;
}

function wornOnHolder(state: ShotState) {
  const held = heldNames(state.holders);
  if (held.length === 0) return [];
  return state.worn.filter((id) => {
    const needle = id.replace(/-/g, " ").toLowerCase();
    return held.some((name) => name.includes(needle) || name.includes(id.toLowerCase()));
  });
}

function footwearIdsOf(contract: ShotContract) {
  if (contract.footwear && contract.footwear.length > 0) return contract.footwear;
  return [...new Set([...contract.requires.worn, ...contract.ensures.worn])]
    .filter((id) => /shoe/i.test(id));
}

function countViolations(contract: ShotContract): ContractViolation[] {
  const found: ContractViolation[] = [];
  const footwear = footwearIdsOf(contract);
  const unitFor = (id: string) => (footwear.includes(id) ? 2 : 1);

  for (const state of [contract.requires, contract.ensures]) {
    const held = wornOnHolder(state);
    if (held.length > 0) {
      found.push({
        code: "worn-and-held",
        shot: contract.shot,
        message:
          `Shot ${contract.shot} has ${held.join(", ")} both worn and on a holder.`,
      });
    }

    for (const id of new Set([...Object.keys(state.counts ?? {}), ...state.worn])) {
      const count = state.counts?.[id] ?? 0;
      const unit = unitFor(id);
      if (count > unit) {
        found.push({
          code: "duplicate-garment",
          shot: contract.shot,
          message:
            `Shot ${contract.shot} counts ${count} of ${id}, which is more than the ${unit} ` +
            `that should exist.`,
        });
        continue;
      }
      if (count !== 0 && count !== unit) {
        found.push({
          code: "count",
          shot: contract.shot,
          message:
            `Shot ${contract.shot} counts ${count} of ${id}. A garment is ${unit} or it is absent.`,
        });
        continue;
      }
      if (state.worn.includes(id) && count !== unit) {
        found.push({
          code: "count",
          shot: contract.shot,
          message:
            `Shot ${contract.shot} wears ${id} but counts ${count}, not ${unit}.`,
        });
      }
    }
  }

  for (const id of footwear) {
    for (const state of [contract.requires, contract.ensures]) {
      const count = state.counts?.[id];
      if (count === undefined) continue;
      if (count !== 0 && count !== 2) {
        found.push({
          code: "footwear-count",
          shot: contract.shot,
          message:
            `Shot ${contract.shot} counts ${count} ${id}, but footwear is a pair and must be 0 or 2.`,
        });
      }
    }
  }

  for (const invariant of contract.invariants) {
    const match = invariant.match(/exactly\s+(\d+|one|two|three|four|a|an)\s+(.+?)(?:,|$)/i);
    if (!match) continue;
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, a: 1, an: 1 };
    const raw = match[1].toLowerCase();
    const count = words[raw] ?? Number(raw);
    const label = match[2].toLowerCase();
    if (/shoe/i.test(label) && count !== 2) {
      found.push({
        code: "footwear-count",
        shot: contract.shot,
        message:
          `Shot ${contract.shot} invariant "${invariant}" uses a footwear count that is not a pair.`,
      });
      continue;
    }
    if (!/shoe/i.test(label) && count !== 1) {
      found.push({
        code: "garment-integrity",
        shot: contract.shot,
        message:
          `Shot ${contract.shot} invariant "${invariant}" counts a garment as ${count}. ` +
          "A garment stays one whole piece.",
      });
    }
  }

  return found;
}

export function validateContracts(contracts: ShotContract[]): ContractValidation {
  const violations: ContractViolation[] = [];

  for (const contract of contracts) {
    if (contract.steps.length > MAX_STEPS_PER_SHOT) {
      violations.push({
        code: "too-many-steps",
        shot: contract.shot,
        suggestSplit: true,
        message:
          `Shot ${contract.shot} has ${contract.steps.length} steps, which is more than ` +
          `${MAX_STEPS_PER_SHOT}. Split it so no shot has more than ${MAX_STEPS_PER_SHOT} steps. ` +
          `Suggested split after step ${MAX_STEPS_PER_SHOT}.`,
      });
    }
    violations.push(...countViolations(contract));
  }

  const ordered = [...contracts].sort((a, b) => a.shot - b.shot);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (sameShotState(current.requires, previous.ensures)) continue;
    const appeared = current.requires.worn.filter((id) => !previous.ensures.worn.includes(id));
    const missing = previous.ensures.worn.filter((id) => !current.requires.worn.includes(id));
    const extras = [
      appeared.length > 0 ? `Reappeared or newly required: ${appeared.join(", ")}.` : "",
      missing.length > 0 ? `Missing from this start: ${missing.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
    violations.push({
      code: "requires-mismatch",
      shot: current.shot,
      message:
        `Shot ${current.shot} requires does not match shot ${previous.shot} ensures.` +
        (extras ? ` ${extras}` : ""),
    });
  }

  return { ok: violations.length === 0, violations };
}

export function validateContractsAgainstPlan(
  plan: ContinuityPlan,
  contracts?: ShotContract[],
): ContractValidation {
  const derived = deriveContracts(plan);
  const authored = contracts ?? derived;
  const result = validateContracts(authored);

  for (const contract of contracts ?? []) {
    const expected = derived.find((entry) => entry.shot === contract.shot);
    if (!expected) continue;
    const stateMatches = sameShotState(contract.requires, expected.requires)
      && sameShotState(contract.ensures, expected.ensures);
    const textMatches = sameTextList(contract.steps, expected.steps)
      && sameTextList(contract.invariants, expected.invariants)
      && sameTextList(contract.forbidden, expected.forbidden);
    if (!stateMatches || !textMatches) {
      result.violations.push({
        code: "ledger-mismatch",
        shot: contract.shot,
        message:
          `Shot ${contract.shot} does not match the state derived by replaying the continuity ledger ` +
          "(worn, holders, counts, steps, invariants, or forbidden).",
      });
    }

    for (const layer of allLayers(plan)) {
      const inPlay = contract.requires.worn.includes(layer.id)
        || contract.ensures.worn.includes(layer.id)
        || (contract.requires.counts?.[layer.id] ?? 0) > 0
        || (contract.ensures.counts?.[layer.id] ?? 0) > 0;
      if (!inPlay) continue;
      if (contract.invariants.some((line) => line.includes(layer.item))) continue;
      result.violations.push({
        code: "garment-integrity",
        shot: contract.shot,
        message:
          `Shot ${contract.shot} invariants do not name "${layer.item}" verbatim.`,
      });
    }
  }

  const weighted = evaluateWeighted(plan);
  result.violations.push(...weighted.violations);

  return { ok: result.violations.length === 0, violations: result.violations };
}

/**
 * Prompt wording taken from the contract. Invariants are copied word for word,
 * steps are named in order, and every shot gets a forbidden clause.
 */
export function promptFromContract(contract: ShotContract): string {
  const parts: string[] = [];
  if (contract.invariants.length > 0) {
    parts.push(contract.invariants.join(" "));
  }
  if (contract.steps.length > 0) {
    parts.push(`Steps in order: ${contract.steps.join("; ")}.`);
  }
  if (contract.forbidden.length > 0) {
    parts.push(`Do not show: ${contract.forbidden.join("; ")}.`);
  } else {
    parts.push(
      "Do not show anything that contradicts this shot's required start state, end state, or invariants.",
    );
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function attachContractPrompts(plan: ContinuityPlan, shots: ShotContinuity[]): ShotContinuity[] {
  const contracts = deriveContracts(plan);
  return shots.map((shot, index) => ({
    ...shot,
    contractPrompt: contracts[index] ? promptFromContract(contracts[index]) : shot.contractPrompt,
  }));
}

function gateShell(
  partial: {
    ok: boolean;
    blocked: boolean;
    status: GateStatus;
    violations: ContractViolation[];
    message?: string;
    tier1?: { score: number; pass: boolean };
    vision?: VisionGate;
    warnings?: string[];
  },
): RenderGateResult {
  return {
    ok: partial.ok,
    blocked: partial.blocked,
    status: partial.status,
    violations: partial.violations,
    ...(partial.message ? { message: partial.message } : {}),
    tier0: partial.status === "pass" ? "pass" : "fail",
    ...(partial.tier1 ? { tier1: partial.tier1 } : {}),
    tier2: "style-only",
    vision: partial.vision ?? "not-required",
    ...(partial.warnings && partial.warnings.length > 0 ? { warnings: partial.warnings } : {}),
  };
}

export function decideSpend(confirm: boolean, gate: RenderGateResult): "estimate" | "refused" | "spend" {
  if (!confirm) return "estimate";
  if (gate.blocked || gate.status === "unchecked" || gate.status === "fail") return "refused";
  if (gate.status === "pass" || gate.status === "override") return "spend";
  const unreachable: never = gate.status;
  return unreachable;
}

export function gateRenderSequence(input: RenderGateInput): RenderGateResult {
  if (!input.plan && !input.contracts) {
    const unchecked: ContractViolation = {
      code: "unchecked",
      shot: 0,
      message: RENDER_UNCHECKED,
    };
    if (input.overrideValidation) {
      return gateShell({
        ok: false,
        blocked: false,
        status: "override",
        violations: [unchecked],
        message: "No ledger or contracts were provided; overrideValidation is set, so rendering may proceed.",
      });
    }
    return gateShell({
      ok: false,
      blocked: true,
      status: "unchecked",
      violations: [unchecked],
      message: RENDER_UNCHECKED,
    });
  }

  const result = input.plan
    ? validateContractsAgainstPlan(input.plan, input.contracts)
    : validateContracts(input.contracts ?? []);
  const weighted = input.plan ? evaluateWeighted(input.plan) : undefined;
  // validateContractsAgainstPlan already appends weighted violations. When the
  // caller passed contracts and a plan, those violations are in `result`.
  // When only a plan was passed, same path. Pull tier metadata either way.
  const tier1 = weighted?.tier1;
  const vision = weighted?.vision ?? "not-required";
  const warnings = weighted?.warnings ?? [];

  if (result.ok) {
    return gateShell({
      ok: true,
      blocked: false,
      status: "pass",
      violations: [],
      tier1,
      vision,
      warnings,
    });
  }

  if (input.overrideValidation) {
    return gateShell({
      ok: false,
      blocked: false,
      status: "override",
      violations: result.violations,
      message:
        "Shot contracts failed validation; overrideValidation is set, so rendering may proceed.",
      tier1,
      vision,
      warnings,
    });
  }

  return gateShell({
    ok: false,
    blocked: true,
    status: "fail",
    violations: result.violations,
    message: RENDER_BLOCKED_BY_CONTRACT,
    tier1,
    vision,
    warnings,
  });
}

/** Pre-video hook used by board_film and render_sequence. */
export function runPreVideoGate(input: RenderGateInput): RenderGateResult {
  return gateRenderSequence(input);
}

/**
 * Vision auditor factory. The default implementation is a stub that refuses to
 * run, because a vision pass costs money and that cost has not been measured.
 * Tests and a future caller inject a real implementation; nothing here calls
 * an image or video API.
 */
export function createContinuityAuditor(impl?: ContinuityAuditor): ContinuityAuditor {
  return impl ?? unimplementedContinuityAuditor();
}

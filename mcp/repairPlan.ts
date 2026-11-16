/**
 * Shot dependency graph and least-cost repair options.
 *
 * Edges come from frames that were actually used: a later shot's first frame
 * matching the previous shot's extracted frame or pinned board still, and an
 * extension when the shot names the clip it continued. Options are quotes.
 * Nothing in this module renders.
 */

import { STILL_QUOTE_USD, VIDEO_USD_PER_SECOND, authorizeSpend, type SpendDecision, type VideoResolution } from "./costGate.ts";

export const REPAIR_VERSION = 1 as const;

export type DependencyKind = "last-frame-seed" | "end-pin" | "board-still" | "extension" | "inferred";

export type DependencyShot = {
  index: number;
  durationSeconds: number;
  pin: "start" | "both";
  framePath?: string;
  firstFramePath?: string;
  lastFramePath?: string;
  boardStillPaths?: string[];
  extendedFrom?: string;
  /**
   * False on a legacy shot that never recorded the frame it actually opened on.
   * The graph then marks the link inferred instead of asserting a seed.
   */
  framesRecorded?: boolean;
};

export type DependencyEdge = {
  fromShot: number;
  toShot: number;
  kind: DependencyKind;
  artifact?: string;
  /** False when the link was not recorded and must not be priced as fact. */
  verified: boolean;
};

export type DependencyNode = {
  shot: number;
  durationSeconds: number;
  pin: "start" | "both";
  seededByShot?: number;
  boardStills: string[];
  extendedFrom?: string;
};

export type DependencyGraph = {
  version: typeof REPAIR_VERSION;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
};

export const REPAIR_STRATEGIES = [
  "retry-alone",
  "retry-dependents",
  "reboard-boundary",
  "accept-note",
] as const;

export type RepairStrategyId = (typeof REPAIR_STRATEGIES)[number];

export type RepairOption = {
  id: RepairStrategyId;
  costUsd: number;
  fixes: string[];
  leavesBroken: string[];
  shotsToRender: number[];
  stillsToBuy: number;
  requiresApproval: true;
};

export type RepairProposal = {
  version: typeof REPAIR_VERSION;
  badShot: number;
  resolution: VideoResolution;
  options: RepairOption[];
  executed: false;
  willRender: false;
  willSpend: false;
};

function videoUsd(durations: number[], resolution: VideoResolution): number {
  const rate = VIDEO_USD_PER_SECOND[resolution];
  return Math.round(durations.reduce((sum, duration) => sum + duration * rate, 0) * 100) / 100;
}

function durationOf(graph: DependencyGraph, shot: number): number {
  return graph.nodes.find((node) => node.shot === shot)?.durationSeconds ?? 0;
}

export function buildDependencyGraph(shots: DependencyShot[]): DependencyGraph {
  const nodes: DependencyNode[] = shots.map((shot) => ({
    shot: shot.index,
    durationSeconds: shot.durationSeconds,
    pin: shot.pin,
    boardStills: [...(shot.boardStillPaths ?? [])],
    ...(shot.extendedFrom ? { extendedFrom: shot.extendedFrom } : {}),
  }));
  const edges: DependencyEdge[] = [];

  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1];
    const next = shots[index];
    const node = nodes[index];
    if (next.framesRecorded === false || previous.framesRecorded === false) {
      edges.push({
        fromShot: previous.index,
        toShot: next.index,
        kind: "inferred",
        verified: false,
      });
      continue;
    }
    if (next.firstFramePath && previous.framePath && next.firstFramePath === previous.framePath) {
      edges.push({
        fromShot: previous.index,
        toShot: next.index,
        kind: "last-frame-seed",
        artifact: previous.framePath,
        verified: true,
      });
      node.seededByShot = previous.index;
    } else if (next.firstFramePath && previous.lastFramePath && next.firstFramePath === previous.lastFramePath) {
      const fromBoard = (previous.boardStillPaths ?? []).includes(previous.lastFramePath)
        || previous.pin === "both";
      edges.push({
        fromShot: previous.index,
        toShot: next.index,
        kind: fromBoard ? "board-still" : "end-pin",
        artifact: previous.lastFramePath,
        verified: true,
      });
      node.seededByShot = previous.index;
    } else {
      edges.push({
        fromShot: previous.index,
        toShot: next.index,
        kind: "inferred",
        verified: false,
      });
    }
  }

  for (const shot of shots) {
    if (!shot.extendedFrom) continue;
    edges.push({
      fromShot: shot.index,
      toShot: shot.index,
      kind: "extension",
      artifact: shot.extendedFrom,
      verified: true,
    });
  }

  return { version: REPAIR_VERSION, nodes, edges };
}

function downstreamShots(graph: DependencyGraph, badShot: number, kinds: DependencyKind[]): number[] {
  const chain = graph.edges.filter((edge) => edge.verified && kinds.includes(edge.kind) && edge.fromShot !== edge.toShot);
  const found: number[] = [];
  const seen = new Set<number>([badShot]);
  const queue = [badShot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const edge of chain) {
      if (edge.fromShot !== current || seen.has(edge.toShot)) continue;
      seen.add(edge.toShot);
      found.push(edge.toShot);
      queue.push(edge.toShot);
    }
  }
  return found;
}

function hardCuts(badShot: number, later: number[]): string[] {
  return later.map((shot) => `The join into shot ${shot} stays a hard cut because shot ${shot} still starts from the original shot ${badShot}.`);
}

export function proposeRepair(input: {
  graph: DependencyGraph;
  badShot: number;
  resolution?: VideoResolution;
}): RepairProposal {
  const resolution = input.resolution ?? "720p";
  const bad = input.graph.nodes.find((node) => node.shot === input.badShot);
  // A retry keeps an end pin and a board still, so those next shots are not re-rendered.
  const later = downstreamShots(input.graph, input.badShot, ["last-frame-seed"]);
  const pinned = downstreamShots(input.graph, input.badShot, ["board-still", "end-pin"]);
  const inferred = input.graph.edges.filter(
    (edge) => edge.kind === "inferred" && edge.verified === false && edge.fromShot === input.badShot && edge.toShot !== input.badShot,
  );
  const badDuration = bad ? [bad.durationSeconds] : [];
  const laterDurations = later.map((shot) => durationOf(input.graph, shot));
  const boundaryStill = input.graph.edges.find(
    (edge) => edge.fromShot === input.badShot && edge.verified && (edge.kind === "board-still" || edge.kind === "end-pin"),
  );
  const extension = input.graph.edges.find(
    (edge) => edge.kind === "extension" && edge.fromShot === input.badShot,
  );

  const alone: RepairOption = {
    id: "retry-alone",
    costUsd: videoUsd(badDuration, resolution),
    fixes: [`Re-renders shot ${input.badShot} only.`],
    leavesBroken: later.length > 0
      ? hardCuts(input.badShot, later)
      : pinned.length > 0
        ? [`Shot ${pinned.join(", ")} keeps the pinned boundary frame, so this retry does not open a new cut.`]
        : inferred.map((edge) => (
          `The link from shot ${edge.fromShot} to shot ${edge.toShot} was not recorded, so it is unverified. ` +
          `retry_shot will treat the join after shot ${input.badShot} as a cut.`
        )),
    shotsToRender: [input.badShot],
    stillsToBuy: 0,
    requiresApproval: true,
  };

  const withDependents: RepairOption = {
    id: "retry-dependents",
    costUsd: videoUsd([...badDuration, ...laterDurations], resolution),
    fixes: [
      `Re-renders shot ${input.badShot} and ${later.length === 0 ? "no downstream shot" : `shot ${later.join(", ")}`}, which ${later.length === 1 ? "was" : "were"} seeded from it.`,
    ],
    leavesBroken: extension
      ? [`Shot ${input.badShot} was an extension of ${extension.artifact}. Re-rendering replaces that extension; the source clip is not itself a later shot.`]
      : [],
    shotsToRender: [input.badShot, ...later],
    stillsToBuy: 0,
    requiresApproval: true,
  };

  const reboardShots = [input.badShot, ...new Set([...later, ...pinned])];
  const reboard: RepairOption = {
    id: "reboard-boundary",
    costUsd: Math.round((STILL_QUOTE_USD + videoUsd(reboardShots.map((shot) => durationOf(input.graph, shot)), resolution)) * 100) / 100,
    fixes: [
      boundaryStill
        ? `Buys one boundary still again (${boundaryStill.artifact}) and re-renders the shots that meet on it.`
        : "Buys one boundary still and re-renders this shot and the shots seeded from it.",
    ],
    leavesBroken: boundaryStill
      ? []
      : ["No shared boundary still is recorded on this cut, so the new still is a new frame, not a reuse."],
    shotsToRender: reboardShots,
    stillsToBuy: 1,
    requiresApproval: true,
  };

  const accept: RepairOption = {
    id: "accept-note",
    costUsd: 0,
    fixes: [],
    leavesBroken: [
      `Shot ${input.badShot} stays as rendered.`,
      ...hardCuts(input.badShot, later),
    ],
    shotsToRender: [],
    stillsToBuy: 0,
    requiresApproval: true,
  };

  const options = [accept, alone, withDependents, reboard].sort((a, b) => a.costUsd - b.costUsd || a.id.localeCompare(b.id));

  return {
    version: REPAIR_VERSION,
    badShot: input.badShot,
    resolution,
    options,
    executed: false,
    willRender: false,
    willSpend: false,
  };
}

export function approveRepairOption(input: {
  option: RepairOption;
  fingerprint: string;
  confirm: boolean;
  approvedUsd?: number;
  approvedKind?: "board" | "video" | "still" | "extend" | "retry";
  approvedFingerprint?: string;
  overrideValidation?: boolean;
}): { decision: SpendDecision; executed: false; willRender: false; willSpend: false; reason?: string } {
  const auth = authorizeSpend({
    kind: "retry",
    usd: input.option.costUsd,
    fingerprint: input.fingerprint,
    confirm: input.confirm,
    approvedUsd: input.approvedUsd,
    approvedKind: input.approvedKind,
    approvedFingerprint: input.approvedFingerprint,
    overrideValidation: input.overrideValidation,
  });
  return {
    decision: auth.decision,
    executed: false,
    willRender: false,
    willSpend: false,
    ...(auth.reason ? { reason: auth.reason } : {}),
  };
}

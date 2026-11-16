/**
 * Evidence review of what crosses a cut.
 *
 * Each boundary finding is measured, visually flagged, or unverified. Style
 * and story notes are ignored. This function does not render, delete, or
 * reorder anything. The vision auditor stays unwired.
 */

import type { VideoResolution } from "./costGate.ts";
import {
  buildDependencyGraph,
  proposeRepair,
  type DependencyShot,
  type RepairProposal,
} from "./repairPlan.ts";

export const REVIEW_VERSION = 1 as const;

export const FINDING_CLASSES = ["measured", "visually-flagged", "unverified"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export const BOUNDARY_TOPICS = ["wardrobe", "props", "pose", "lighting", "identity"] as const;
export type BoundaryTopic = (typeof BOUNDARY_TOPICS)[number];

export type ReviewEvidence = {
  method: string;
  artifactPaths: string[];
  value?: number | string;
  /** True when a cited frame was extracted for the review and then removed. */
  ephemeral?: boolean;
};

export type ContinuityFinding = {
  topic: BoundaryTopic;
  class: FindingClass;
  afterShot: number;
  beforeShot: number;
  summary: string;
  evidence?: ReviewEvidence;
  abstention?: string;
  /** True when the ledger change is a planned wardrobe or prop event, not a defect. */
  planned?: boolean;
};

export type ReviewProp = {
  id: string;
  locationId: string;
  placement: string;
  holder?: string;
};

export type ReviewShot = {
  index: number;
  worn?: string[];
  props?: ReviewProp[];
  lastFramePath?: string;
  firstFramePath?: string;
  referencePath?: string;
  durationSeconds?: number;
  pin?: "start" | "both";
  boardStillPaths?: string[];
  extendedFrom?: string;
};

export type SeamMeasurement = {
  afterShot: number;
  agreement?: number;
  method?: string;
  meanLumaDelta?: number;
  identityAgreement?: number;
  /** disk: computed from files this process read. caller: not a measurement. */
  source?: "disk" | "caller";
};

export type ContinuityReview = {
  version: typeof REVIEW_VERSION;
  findings: ContinuityFinding[];
  repairProposal?: RepairProposal;
  executed: false;
  willRender: false;
  willSpend: false;
  mutatedPaths: [];
};

export type ReviewInput = {
  shots: ReviewShot[];
  measurements?: SeamMeasurement[];
  fileExists?: (path: string) => boolean;
  filesIdentical?: (left: string, right: string) => boolean;
  ledgerArtifact?: string;
  styleNotes?: string[];
  narrativeSuggestions?: string[];
  resolution?: VideoResolution;
  /** Shot numbers where a wardrobe or prop event was planned. Those changes are not defects. */
  plannedShots?: number[];
};

function sortedIds(ids: string[] | undefined): string[] {
  return [...(ids ?? [])].map((id) => id.trim()).filter(Boolean).sort();
}

function propSignature(prop: ReviewProp): string {
  return [prop.id, prop.locationId, prop.placement, prop.holder ?? ""].join("|");
}

function bothExist(paths: string[], fileExists: ((path: string) => boolean) | undefined): boolean {
  if (!fileExists) return false;
  return paths.length > 0 && paths.every((path) => path.trim().length > 0 && fileExists(path));
}

function measured(
  topic: BoundaryTopic,
  afterShot: number,
  beforeShot: number,
  summary: string,
  evidence: ReviewEvidence,
): ContinuityFinding {
  return { topic, class: "measured", afterShot, beforeShot, summary, evidence };
}

function flagged(
  topic: BoundaryTopic,
  afterShot: number,
  beforeShot: number,
  summary: string,
  artifactPaths: string[],
): ContinuityFinding {
  return {
    topic,
    class: "visually-flagged",
    afterShot,
    beforeShot,
    summary,
    evidence: { method: "frames-on-disk", artifactPaths },
  };
}

function unverified(
  topic: BoundaryTopic,
  afterShot: number,
  beforeShot: number,
  abstention: string,
): ContinuityFinding {
  return {
    topic,
    class: "unverified",
    afterShot,
    beforeShot,
    summary: abstention,
    abstention,
  };
}

function wardrobeFinding(
  previous: ReviewShot,
  next: ReviewShot,
  ledgerArtifact: string,
  planned: boolean,
): ContinuityFinding {
  if (!previous.worn || !next.worn) {
    return unverified(
      "wardrobe",
      previous.index,
      next.index,
      "No wardrobe ledger on one side of the cut, so the worn stack was not compared.",
    );
  }
  const before = sortedIds(previous.worn);
  const after = sortedIds(next.worn);
  const changed = before.join(",") !== after.join(",");
  const finding = measured(
    "wardrobe",
    previous.index,
    next.index,
    changed
      ? `Wardrobe changed across the cut from [${before.join(", ")}] to [${after.join(", ")}].`
      : `Wardrobe is unchanged across the cut: [${before.join(", ")}].`,
    {
      method: "ledger-worn-diff",
      artifactPaths: [ledgerArtifact],
      value: changed ? "changed" : "unchanged",
    },
  );
  if (changed && planned) {
    finding.planned = true;
    finding.summary = `${finding.summary} The change is a planned wardrobe event, not a defect.`;
  }
  return finding;
}

function propsFinding(previous: ReviewShot, next: ReviewShot, ledgerArtifact: string): ContinuityFinding {
  if (!previous.props || !next.props) {
    return unverified(
      "props",
      previous.index,
      next.index,
      "No prop ledger on one side of the cut, so held and placed props were not compared.",
    );
  }
  const before = previous.props.map(propSignature).sort();
  const after = next.props.map(propSignature).sort();
  const changed = before.join("\n") !== after.join("\n");
  return measured(
    "props",
    previous.index,
    next.index,
    changed
      ? "Held or placed props changed across the cut."
      : "Held and placed props are unchanged across the cut.",
    {
      method: "ledger-prop-diff",
      artifactPaths: [ledgerArtifact],
      value: changed ? "changed" : "unchanged",
    },
  );
}

function poseFinding(
  previous: ReviewShot,
  next: ReviewShot,
  measurement: SeamMeasurement | undefined,
  fileExists: ((path: string) => boolean) | undefined,
): ContinuityFinding {
  const paths = [previous.lastFramePath, next.firstFramePath].filter((path): path is string => Boolean(path));
  if (paths.length < 2) {
    return unverified(
      "pose",
      previous.index,
      next.index,
      "No frame on one side of the cut, so pose at the seam was not checked.",
    );
  }
  if (paths[0] === paths[1]) {
    return unverified(
      "pose",
      previous.index,
      next.index,
      "The two seam paths are the same file, so pose at the cut was not checked.",
    );
  }
  if (!bothExist(paths, fileExists)) {
    return unverified(
      "pose",
      previous.index,
      next.index,
      "A seam frame path is missing on disk, so pose at the seam was not checked.",
    );
  }
  if (
    measurement?.source === "disk"
    && typeof measurement.agreement === "number"
    && Number.isFinite(measurement.agreement)
  ) {
    return measured(
      "pose",
      previous.index,
      next.index,
      `Seam agreement measured from the files on disk is ${measurement.agreement}.`,
      {
        method: measurement.method?.trim() || "closing-frame-agreement",
        artifactPaths: paths,
        value: measurement.agreement,
      },
    );
  }
  if (measurement && measurement.source !== "disk" && typeof measurement.agreement === "number") {
    return unverified(
      "pose",
      previous.index,
      next.index,
      "Caller-reported seam agreement was not measured from the files on disk.",
    );
  }
  return flagged(
    "pose",
    previous.index,
    next.index,
    "Both seam frames are on disk and were not measured. Look at those frames; this is not a score.",
    paths,
  );
}

function lightingFinding(
  previous: ReviewShot,
  next: ReviewShot,
  measurement: SeamMeasurement | undefined,
  fileExists: ((path: string) => boolean) | undefined,
): ContinuityFinding {
  const paths = [previous.lastFramePath, next.firstFramePath].filter((path): path is string => Boolean(path));
  if (
    measurement?.source === "disk"
    && typeof measurement.meanLumaDelta === "number"
    && Number.isFinite(measurement.meanLumaDelta)
    && bothExist(paths, fileExists)
  ) {
    return measured(
      "lighting",
      previous.index,
      next.index,
      `Mean luminance delta across the cut is ${measurement.meanLumaDelta}.`,
      {
        method: "mean-luma-delta",
        artifactPaths: paths,
        value: measurement.meanLumaDelta,
      },
    );
  }
  return unverified(
    "lighting",
    previous.index,
    next.index,
    "Luminance method unavailable, so lighting and time of day were not judged.",
  );
}

function identityFinding(
  previous: ReviewShot,
  next: ReviewShot,
  measurement: SeamMeasurement | undefined,
  fileExists: ((path: string) => boolean) | undefined,
  filesIdentical: ((left: string, right: string) => boolean) | undefined,
): ContinuityFinding {
  const reference = next.referencePath ?? previous.referencePath;
  const frame = next.firstFramePath ?? previous.lastFramePath;
  if (!reference) {
    return unverified(
      "identity",
      previous.index,
      next.index,
      "No character reference on this cut, so identity was not checked.",
    );
  }
  if (!frame || !fileExists?.(reference) || !fileExists(frame)) {
    return unverified(
      "identity",
      previous.index,
      next.index,
      "The character reference or the seam frame is not on disk, so identity was not checked.",
    );
  }
  if (filesIdentical?.(reference, frame)) {
    return measured(
      "identity",
      previous.index,
      next.index,
      "The seam frame is byte-identical to the character reference.",
      {
        method: "sha256-identity",
        artifactPaths: [frame, reference],
        value: 1,
      },
    );
  }
  if (
    measurement?.source === "disk"
    && typeof measurement.identityAgreement === "number"
    && Number.isFinite(measurement.identityAgreement)
  ) {
    return measured(
      "identity",
      previous.index,
      next.index,
      `Identity agreement against the reference is ${measurement.identityAgreement}.`,
      {
        method: "identity-agreement",
        artifactPaths: [frame, reference],
        value: measurement.identityAgreement,
      },
    );
  }
  if (measurement && measurement.source !== "disk" && typeof measurement.identityAgreement === "number") {
    return unverified(
      "identity",
      previous.index,
      next.index,
      "Caller-reported identity agreement was not measured from the files on disk.",
    );
  }
  return unverified(
    "identity",
    previous.index,
    next.index,
    "Identity method unavailable; the vision auditor is not wired and no embedding was measured.",
  );
}

function defectShot(findings: ContinuityFinding[]): number | undefined {
  for (const finding of findings) {
    if (finding.planned) continue;
    if (finding.class !== "measured") continue;
    if (finding.topic !== "pose") continue;
    if (typeof finding.evidence?.value !== "number" || finding.evidence.value >= 0.6) continue;
    return finding.afterShot;
  }
  return undefined;
}

function dependencyShots(shots: ReviewShot[]): DependencyShot[] {
  return shots.map((shot) => ({
    index: shot.index,
    durationSeconds: shot.durationSeconds ?? 0,
    pin: shot.pin ?? "start",
    framePath: shot.lastFramePath,
    firstFramePath: shot.firstFramePath,
    lastFramePath: shot.boardStillPaths?.[0],
    boardStillPaths: shot.boardStillPaths,
    extendedFrom: shot.extendedFrom,
  }));
}

export function reviewContinuity(input: ReviewInput): ContinuityReview {
  const ledgerArtifact = input.ledgerArtifact ?? "ledger";
  const findings: ContinuityFinding[] = [];
  const shots = [...input.shots].sort((a, b) => a.index - b.index);
  // Style notes and narrative suggestions are accepted so a caller can pass
  // them, and then dropped. They are not boundary findings.
  void input.styleNotes;
  void input.narrativeSuggestions;

  for (let index = 0; index < shots.length - 1; index += 1) {
    const previous = shots[index];
    const next = shots[index + 1];
    const measurement = (input.measurements ?? []).find((entry) => entry.afterShot === previous.index);
    const planned = (input.plannedShots ?? []).includes(next.index) || (input.plannedShots ?? []).includes(previous.index);
    findings.push(
      wardrobeFinding(previous, next, ledgerArtifact, planned),
      propsFinding(previous, next, ledgerArtifact),
      poseFinding(previous, next, measurement, input.fileExists),
      lightingFinding(previous, next, measurement, input.fileExists),
      identityFinding(previous, next, measurement, input.fileExists, input.filesIdentical),
    );
  }

  const badShot = defectShot(findings);
  const canPrice = badShot !== undefined && shots.every((shot) => typeof shot.durationSeconds === "number");
  const repairProposal: RepairProposal | undefined = canPrice
    ? proposeRepair({
      graph: buildDependencyGraph(dependencyShots(shots)),
      badShot,
      resolution: input.resolution,
    })
    : undefined;

  return {
    version: REVIEW_VERSION,
    findings,
    ...(repairProposal ? { repairProposal } : {}),
    executed: false,
    willRender: false,
    willSpend: false,
    mutatedPaths: [],
  };
}

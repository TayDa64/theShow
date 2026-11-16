/**
 * Deterministic coverage, structure, and pacing suggestions.
 *
 * Every rule is a pure function with a stable id and version. Nothing here
 * renders, spends, reorders a caller's beats, or reads a prompt as a shot type.
 */

import { durationFromLine } from "./beats.ts";

export const COVERAGE_VERSION = 1 as const;
export const RULE_VERSION = 1 as const;
export const RENDERER_MAX_SECONDS = 15;

export const COVERAGE_RULE_IDS = [
  "coverage.wide-before-first-close",
  "coverage.consecutive-same-shot",
  "coverage.reestablish-on-location-change",
  "coverage.line-shorter-than-speech",
  "coverage.line-without-person-coverage",
  "structure.ladder-order",
  "pacing.total-duration",
  "pacing.shot-exceeds-renderer-max",
] as const;

export type CoverageRuleId = (typeof COVERAGE_RULE_IDS)[number];
export type SuggestionKind = "coverage" | "structure" | "pacing";
export type SuggestionTool = "plan_storyboard" | "render_sequence" | "retry_shot" | "board_film";

export type CoverageShot = {
  index: number;
  title?: string;
  shotType?: string;
  framing?: string;
  durationSeconds?: number;
  locationId?: string;
  line?: { text?: string; delivery?: "spoken" | "sung" };
  /** Set when the line came from ledger.spokenLines, which records speech. */
  lineSource?: "caller" | "spoken-ledger";
};

export type LadderBeat = { at: number; title: string };

export type CoverageRequest = {
  shots: CoverageShot[];
  source: "plan" | "job";
  usedBuiltInLadder: boolean;
  callerSuppliedBeats: boolean;
  targetDurationSeconds?: number;
  artifactPaths: string[];
  ladder: readonly LadderBeat[];
};

export type SuggestionEvidence = {
  method: string;
  values: Record<string, string | number | boolean | null>;
  artifactPaths: string[];
};

export type CoverageSuggestion = {
  ruleId: CoverageRuleId;
  ruleVersion: typeof RULE_VERSION;
  shots: number[];
  kind: SuggestionKind;
  severity: "info" | "consider";
  class: "measured" | "unverified";
  summary: string;
  evidence?: SuggestionEvidence;
  abstention?: string;
  suggestedChange?: { text: string; tool: SuggestionTool };
  wouldSpend: false;
};

export type CoverageReport = {
  version: typeof COVERAGE_VERSION;
  executed: false;
  willRender: false;
  willSpend: false;
  mutatedPaths: [];
  source: "plan" | "job";
  suggestions: CoverageSuggestion[];
  error?: string;
};

const WIDE = new Set(["wide", "establishing"]);
const CLOSE = new Set(["close", "close-up", "closeup", "feet-close"]);
const PERSON = new Set(["medium", "close", "close-up", "closeup", "feet-close"]);

const RULE_KIND: Record<CoverageRuleId, SuggestionKind> = {
  "coverage.wide-before-first-close": "coverage",
  "coverage.consecutive-same-shot": "coverage",
  "coverage.reestablish-on-location-change": "coverage",
  "coverage.line-shorter-than-speech": "coverage",
  "coverage.line-without-person-coverage": "coverage",
  "structure.ladder-order": "structure",
  "pacing.total-duration": "pacing",
  "pacing.shot-exceeds-renderer-max": "pacing",
};

export function ladderTitles(ladder: readonly LadderBeat[], shotCount: number): string[] {
  const counts = new Map<string, number>();
  const titles: string[] = [];
  for (let index = 0; index < shotCount; index += 1) {
    const position = shotCount === 1 ? 0 : index / (shotCount - 1);
    let beat = ladder[0];
    for (const candidate of ladder) {
      if (candidate.at <= position + 1e-9) beat = candidate;
    }
    const base = beat?.title ?? "";
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    titles.push(seen === 0 ? base : `${base} ${seen + 1}`);
  }
  return titles;
}

export function coverageKey(shot: CoverageShot): string | undefined {
  const named = shot.framing?.trim() || shot.shotType?.trim();
  return named ? named.toLowerCase() : undefined;
}

function shotTypesRecorded(shots: CoverageShot[]): boolean {
  return shots.some((shot) => coverageKey(shot) !== undefined);
}

function abstain(
  ruleId: CoverageRuleId,
  shots: number[],
  reason: string,
): CoverageSuggestion {
  return {
    ruleId,
    ruleVersion: RULE_VERSION,
    shots,
    kind: RULE_KIND[ruleId],
    severity: "info",
    class: "unverified",
    summary: reason,
    abstention: reason,
    wouldSpend: false,
  };
}

function changeFor(request: CoverageRequest, addingShot: boolean): CoverageSuggestion["suggestedChange"] {
  if (request.source === "plan") {
    return {
      text: "Re-plan with plan_storyboard. suggest_coverage does not change the plan or call that tool.",
      tool: "plan_storyboard",
    };
  }
  if (addingShot) {
    return {
      text:
        "A new or replaced shot is a new render. Call render_sequence with resumeFromJobId, board_film, or retry_shot. " +
        "Each of those tools prices the work itself and waits for its own approval.",
      tool: "render_sequence",
    };
  }
  return {
    text:
      "Changing this shot is a new render. Call retry_shot or render_sequence. " +
      "Each tool prices the work itself and waits for its own approval.",
    tool: "retry_shot",
  };
}

function measured(
  request: CoverageRequest,
  ruleId: CoverageRuleId,
  shots: number[],
  severity: "info" | "consider",
  summary: string,
  values: Record<string, string | number | boolean | null>,
  addingShot: boolean,
): CoverageSuggestion {
  return {
    ruleId,
    ruleVersion: RULE_VERSION,
    shots,
    kind: RULE_KIND[ruleId],
    severity,
    class: "measured",
    summary,
    evidence: {
      method: ruleId,
      values,
      artifactPaths: request.artifactPaths,
    },
    suggestedChange: changeFor(request, addingShot),
    wouldSpend: false,
  };
}

function missingShotTypeReason(source: CoverageRequest["source"]): string {
  return source === "job" ? "shot type not recorded on this film" : "shot type was not supplied";
}

function wideBeforeClose(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "coverage.wide-before-first-close" as const;
  if (!shotTypesRecorded(request.shots)) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), missingShotTypeReason(request.source))];
  }
  const located = request.shots.filter((shot) => shot.locationId?.trim());
  if (located.length === 0) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), "location not recorded")];
  }
  const suggestions: CoverageSuggestion[] = [];
  let cursor = 0;
  while (cursor < request.shots.length) {
    const location = request.shots[cursor].locationId?.trim();
    if (!location) {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < request.shots.length && request.shots[end].locationId?.trim() === location) end += 1;
    const run = request.shots.slice(cursor, end);
    const closeIndex = run.findIndex((shot) => CLOSE.has(coverageKey(shot) ?? ""));
    if (closeIndex >= 0) {
      const close = run[closeIndex];
      const hasWide = run.slice(0, closeIndex).some((shot) => WIDE.has(coverageKey(shot) ?? ""));
      if (!hasWide) {
        suggestions.push(measured(
          request,
          ruleId,
          [close.index],
          "consider",
          `The first close shot in ${location} has no wide shot before it.`,
          {
            locationId: location,
            shot: close.index,
            shotType: coverageKey(close) ?? null,
          },
          true,
        ));
      }
    }
    cursor = end;
  }
  const missing = request.shots.filter((shot) => !shot.locationId?.trim()).map((shot) => shot.index);
  if (missing.length > 0) {
    suggestions.push(abstain(ruleId, missing, "location not recorded"));
  }
  return suggestions;
}

function consecutiveSame(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "coverage.consecutive-same-shot" as const;
  if (!shotTypesRecorded(request.shots)) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), missingShotTypeReason(request.source))];
  }
  const suggestions: CoverageSuggestion[] = [];
  let run: CoverageShot[] = [];
  let runKey: string | undefined;
  const flush = () => {
    if (runKey && run.length >= 3) {
      suggestions.push(measured(
        request,
        ruleId,
        run.map((shot) => shot.index),
        "consider",
        `${run.length} shots in a row are ${runKey}.`,
        { shotType: runKey, count: run.length },
        false,
      ));
    }
    run = [];
    runKey = undefined;
  };
  for (const shot of request.shots) {
    const key = coverageKey(shot);
    if (!key || key !== runKey) {
      flush();
      if (key) {
        run = [shot];
        runKey = key;
      }
      continue;
    }
    run.push(shot);
  }
  flush();
  return suggestions;
}

function reestablish(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "coverage.reestablish-on-location-change" as const;
  if (!shotTypesRecorded(request.shots)) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), missingShotTypeReason(request.source))];
  }
  const anyLocation = request.shots.some((shot) => shot.locationId?.trim());
  if (!anyLocation) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), "location not recorded")];
  }
  const suggestions: CoverageSuggestion[] = [];
  for (let index = 1; index < request.shots.length; index += 1) {
    const previous = request.shots[index - 1];
    const shot = request.shots[index];
    const from = previous.locationId?.trim();
    const to = shot.locationId?.trim();
    if (!from || !to) {
      suggestions.push(abstain(ruleId, [shot.index], "location not recorded"));
      continue;
    }
    if (from === to) continue;
    const key = coverageKey(shot);
    if (!key) {
      suggestions.push(abstain(ruleId, [shot.index], missingShotTypeReason(request.source)));
      continue;
    }
    if (!WIDE.has(key)) {
      suggestions.push(measured(
        request,
        ruleId,
        [shot.index],
        "consider",
        `The cut from ${from} to ${to} does not open on a wide shot.`,
        { from, to, shot: shot.index, shotType: key },
        true,
      ));
    }
  }
  return suggestions;
}

function lineShorter(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "coverage.line-shorter-than-speech" as const;
  const suggestions: CoverageSuggestion[] = [];
  for (const shot of request.shots) {
    const text = shot.line?.text?.trim();
    if (!text) continue;
    const delivery = shot.line?.delivery;
    if (!delivery && shot.lineSource !== "spoken-ledger") {
      suggestions.push(abstain(ruleId, [shot.index], "line delivery not recorded"));
      continue;
    }
    const pace: "spoken" | "sung" = delivery === "sung" ? "sung" : "spoken";
    if (typeof shot.durationSeconds !== "number" || !Number.isFinite(shot.durationSeconds)) {
      suggestions.push(abstain(ruleId, [shot.index], "duration not recorded"));
      continue;
    }
    const needed = durationFromLine(text, pace);
    if (shot.durationSeconds < needed) {
      suggestions.push(measured(
        request,
        ruleId,
        [shot.index],
        "consider",
        `The line needs about ${needed}s and the shot is ${shot.durationSeconds}s.`,
        {
          neededSeconds: needed,
          durationSeconds: shot.durationSeconds,
          delivery: pace,
          deliverySource: shot.lineSource === "spoken-ledger" ? "spoken-ledger" : "caller",
        },
        false,
      ));
    }
  }
  return suggestions;
}

function lineCoverage(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "coverage.line-without-person-coverage" as const;
  if (!shotTypesRecorded(request.shots)) {
    const withLine = request.shots.filter((shot) => shot.line?.text?.trim());
    if (withLine.length === 0) return [];
    return [abstain(ruleId, withLine.map((shot) => shot.index), missingShotTypeReason(request.source))];
  }
  const suggestions: CoverageSuggestion[] = [];
  for (const shot of request.shots) {
    const text = shot.line?.text?.trim();
    if (!text) continue;
    const key = coverageKey(shot);
    if (!key) {
      suggestions.push(abstain(ruleId, [shot.index], missingShotTypeReason(request.source)));
      continue;
    }
    if (!PERSON.has(key)) {
      suggestions.push(measured(
        request,
        ruleId,
        [shot.index],
        "consider",
        `A line is delivered on a ${key} shot, which is not medium or close coverage.`,
        { shotType: key, shot: shot.index },
        false,
      ));
    }
  }
  return suggestions;
}

function ladderOrder(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "structure.ladder-order" as const;
  if (request.callerSuppliedBeats || !request.usedBuiltInLadder) return [];
  if (request.ladder.length === 0 || request.shots.length === 0) return [];
  const expected = ladderTitles(request.ladder, request.shots.length);
  const actual = request.shots.map((shot) => shot.title?.trim() ?? "");
  if (actual.some((title) => title.length === 0)) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), "shot title not recorded")];
  }
  const mismatches = request.shots.filter((shot, index) => shot.title?.trim() !== expected[index]);
  if (mismatches.length === 0) return [];
  return [measured(
    request,
    ruleId,
    mismatches.map((shot) => shot.index),
    "consider",
    "This plan was marked as the built-in ladder, and the shot titles are not in that order.",
    {
      expected: expected.join(" | "),
      actual: actual.join(" | "),
    },
    false,
  )];
}

function totalDuration(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "pacing.total-duration" as const;
  if (request.targetDurationSeconds === undefined) return [];
  if (!request.shots.every((shot) => typeof shot.durationSeconds === "number" && Number.isFinite(shot.durationSeconds))) {
    return [abstain(ruleId, request.shots.map((shot) => shot.index), "duration not recorded")];
  }
  const total = request.shots.reduce((sum, shot) => sum + (shot.durationSeconds ?? 0), 0);
  if (Math.abs(total - request.targetDurationSeconds) <= 1e-6) return [];
  return [measured(
    request,
    ruleId,
    request.shots.map((shot) => shot.index),
    "info",
    `The shots add up to ${total}s and the target is ${request.targetDurationSeconds}s.`,
    { totalSeconds: total, targetDurationSeconds: request.targetDurationSeconds },
    false,
  )];
}

function shotMax(request: CoverageRequest): CoverageSuggestion[] {
  const ruleId = "pacing.shot-exceeds-renderer-max" as const;
  const suggestions: CoverageSuggestion[] = [];
  for (const shot of request.shots) {
    if (typeof shot.durationSeconds !== "number" || !Number.isFinite(shot.durationSeconds)) continue;
    if (shot.durationSeconds > RENDERER_MAX_SECONDS) {
      suggestions.push(measured(
        request,
        ruleId,
        [shot.index],
        "consider",
        `Shot ${shot.index} is ${shot.durationSeconds}s. A render accepts at most ${RENDERER_MAX_SECONDS}s.`,
        { durationSeconds: shot.durationSeconds, maxSeconds: RENDERER_MAX_SECONDS },
        false,
      ));
    }
  }
  return suggestions;
}

const RULES: Record<CoverageRuleId, (request: CoverageRequest) => CoverageSuggestion[]> = {
  "coverage.wide-before-first-close": wideBeforeClose,
  "coverage.consecutive-same-shot": consecutiveSame,
  "coverage.reestablish-on-location-change": reestablish,
  "coverage.line-shorter-than-speech": lineShorter,
  "coverage.line-without-person-coverage": lineCoverage,
  "structure.ladder-order": ladderOrder,
  "pacing.total-duration": totalDuration,
  "pacing.shot-exceeds-renderer-max": shotMax,
};

export function suggestCoverage(request: CoverageRequest): CoverageReport {
  const suggestions = COVERAGE_RULE_IDS.flatMap((id) => RULES[id](request));
  return {
    version: COVERAGE_VERSION,
    executed: false,
    willRender: false,
    willSpend: false,
    mutatedPaths: [],
    source: request.source,
    suggestions,
  };
}

export function suggestionsFor(request: CoverageRequest, ruleId: CoverageRuleId): CoverageSuggestion[] {
  return RULES[ruleId](request);
}

/** A job's recorded fields only. Prompt text is not read. */
export function coverageShotsFromJob(job: {
  shots?: Array<{
    index?: number;
    title?: string;
    shotType?: string;
    framing?: string;
    durationSeconds?: number;
  }>;
  ledger?: {
    shots?: Array<{ shot?: number; locationId?: string }>;
    spokenLines?: Array<{ shot?: number; line?: string }>;
  };
}): CoverageShot[] {
  return (job.shots ?? []).map((shot, position) => {
    const index = typeof shot.index === "number" ? shot.index : position + 1;
    const ledgerShot = job.ledger?.shots?.find((entry) => entry.shot === index);
    const spoken = job.ledger?.spokenLines?.find((entry) => entry.shot === index);
    const text = spoken?.line?.trim();
    return {
      index,
      ...(shot.title ? { title: shot.title } : {}),
      ...(shot.shotType?.trim() ? { shotType: shot.shotType } : {}),
      ...(shot.framing?.trim() ? { framing: shot.framing } : {}),
      ...(typeof shot.durationSeconds === "number" ? { durationSeconds: shot.durationSeconds } : {}),
      ...(ledgerShot?.locationId?.trim() ? { locationId: ledgerShot.locationId } : {}),
      ...(text ? { line: { text, delivery: "spoken" as const }, lineSource: "spoken-ledger" as const } : {}),
    };
  });
}

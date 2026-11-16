/**
 * Each coverage rule fires on a minimal plan and stays silent on a negative one.
 * Shot type is never read out of a prompt. Caller beats are never reordered.
 */
import { describe, expect, it } from "vitest";
import { BEAT_LADDER } from "../mcp/server.ts";
import {
  coverageShotsFromJob,
  ladderTitles,
  suggestCoverage,
  suggestionsFor,
  type CoverageRequest,
  type CoverageRuleId,
  type CoverageShot,
} from "../mcp/coverageSuggestions.ts";

const ladder = BEAT_LADDER.map((beat) => ({ at: beat.at, title: beat.title }));

function request(shots: CoverageShot[], extra: Partial<CoverageRequest> = {}): CoverageRequest {
  return {
    shots,
    source: "plan",
    usedBuiltInLadder: false,
    callerSuppliedBeats: false,
    artifactPaths: ["caller-supplied"],
    ladder,
    ...extra,
  };
}

function spendKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) spendKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "costQuote" || key === "confirm" || key.startsWith("approved")) found.push(key);
    spendKeys(child, found);
  }
  return found;
}

const clean: CoverageShot[] = [
  { index: 1, title: "Establishing", shotType: "wide", locationId: "kitchen", durationSeconds: 8 },
  {
    index: 2,
    title: "Look",
    shotType: "medium",
    locationId: "kitchen",
    durationSeconds: 8,
    line: { text: "Hello there friend", delivery: "spoken" },
  },
];

describe("suggest_coverage rules", () => {
  it("stays silent on a plan that already has the coverage it asks about", () => {
    const report = suggestCoverage(request(clean, { targetDurationSeconds: 16 }));
    expect(report.executed).toBe(false);
    expect(report.willRender).toBe(false);
    expect(report.willSpend).toBe(false);
    expect(report.mutatedPaths).toEqual([]);
    expect(report.suggestions).toEqual([]);
    expect(spendKeys(report)).toEqual([]);
  });

  it.each([
    ["coverage.wide-before-first-close", [{ index: 1, shotType: "close", locationId: "kitchen", durationSeconds: 8 }], clean],
    ["coverage.consecutive-same-shot", [
      { index: 1, shotType: "medium", locationId: "kitchen", durationSeconds: 4 },
      { index: 2, shotType: "medium", locationId: "kitchen", durationSeconds: 4 },
      { index: 3, shotType: "medium", locationId: "kitchen", durationSeconds: 4 },
    ], [
      { index: 1, shotType: "medium", locationId: "kitchen", durationSeconds: 4 },
      { index: 2, shotType: "medium", locationId: "kitchen", durationSeconds: 4 },
    ]],
    ["coverage.reestablish-on-location-change", [
      { index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 8 },
      { index: 2, shotType: "medium", locationId: "hall", durationSeconds: 8 },
    ], [
      { index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 8 },
      { index: 2, shotType: "wide", locationId: "hall", durationSeconds: 8 },
    ]],
    ["coverage.line-shorter-than-speech", [
      { index: 1, shotType: "medium", locationId: "kitchen", durationSeconds: 3, line: { text: "one two three four five six", delivery: "spoken" as const } },
    ], [
      { index: 1, shotType: "medium", locationId: "kitchen", durationSeconds: 8, line: { text: "one two three four five six", delivery: "spoken" as const } },
    ]],
    ["coverage.line-without-person-coverage", [
      { index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 8, line: { text: "Hello there", delivery: "spoken" as const } },
    ], [
      { index: 1, shotType: "medium", locationId: "kitchen", durationSeconds: 8, line: { text: "Hello there", delivery: "spoken" as const } },
    ]],
    ["pacing.shot-exceeds-renderer-max", [
      { index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 16 },
    ], [
      { index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 15 },
    ]],
  ] as const)("kills a %s miss: the positive fixture fires and the negative one is silent", (ruleId, positive, negative) => {
    const fired = suggestionsFor(request([...positive]), ruleId);
    const quiet = suggestionsFor(request([...negative]), ruleId);
    expect(fired, ruleId).toHaveLength(1);
    expect(fired[0]?.ruleId).toBe(ruleId);
    expect(fired[0]?.ruleVersion).toBe(1);
    expect(fired[0]?.wouldSpend).toBe(false);
    expect(fired[0]?.evidence?.method).toBe(ruleId);
    expect(fired[0]?.abstention).toBeUndefined();
    expect(fired[0]?.suggestedChange?.tool).toBe("plan_storyboard");
    expect(quiet).toEqual([]);
  });

  it("compares total duration only when a target was given", () => {
    const shots = [{ index: 1, shotType: "wide", locationId: "kitchen", durationSeconds: 8 }];
    expect(suggestionsFor(request(shots, { targetDurationSeconds: 10 }), "pacing.total-duration")).toHaveLength(1);
    expect(suggestionsFor(request(shots, { targetDurationSeconds: 8 }), "pacing.total-duration")).toEqual([]);
    expect(suggestionsFor(request(shots), "pacing.total-duration")).toEqual([]);
  });

  it("checks ladder order only for an explicit built-in ladder plan", () => {
    const wrong = [{ index: 1, title: "Climax", shotType: "wide", locationId: "kitchen", durationSeconds: 8 }];
    const right = [{ index: 1, title: "Establishing", shotType: "wide", locationId: "kitchen", durationSeconds: 8 }];
    const fired = suggestionsFor(request(wrong, { usedBuiltInLadder: true }), "structure.ladder-order");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.suggestedChange?.text).not.toMatch(/costQuote|confirm|approved/);
    expect(suggestionsFor(request(right, { usedBuiltInLadder: true }), "structure.ladder-order")).toEqual([]);
    expect(suggestionsFor(request(wrong, { usedBuiltInLadder: true, callerSuppliedBeats: true }), "structure.ladder-order")).toEqual([]);
    expect(suggestionsFor(request(wrong), "structure.ladder-order")).toEqual([]);
  });

  it("kills mutation: reordering caller beats toward the ladder", () => {
    const shots: CoverageShot[] = [
      { index: 1, title: "Climax", shotType: "close-up", locationId: "hall", durationSeconds: 8 },
      { index: 2, title: "Establishing", shotType: "wide", locationId: "hall", durationSeconds: 8 },
    ];
    const before = shots.map((shot) => shot.title);
    const report = suggestCoverage(request(shots, { usedBuiltInLadder: true, callerSuppliedBeats: true }));
    expect(shots.map((shot) => shot.title)).toEqual(before);
    expect(report.suggestions.filter((item) => item.kind === "structure")).toEqual([]);
    expect(report.suggestions.every((item) => item.wouldSpend === false)).toBe(true);
    expect(spendKeys(report)).toEqual([]);
  });

  it("kills mutation: dropping the shot-type abstention and reading the prompt", () => {
    const stored = {
      shots: [{ index: 1, title: "Face", durationSeconds: 8, prompt: "close-up of her face, a wide establishing shot" }],
      ledger: {
        shots: [{ shot: 1, locationId: "kitchen" }],
        spokenLines: [{ shot: 1, line: "hello there" }],
      },
    };
    const shots = coverageShotsFromJob(stored);
    const report = suggestCoverage(request(shots, { source: "job", artifactPaths: ["/films/old.json"] }));
    const measured = report.suggestions.filter((item) => item.class === "measured");
    expect(measured).toEqual([]);
    const abstained = report.suggestions.filter((item) => item.abstention === "shot type not recorded on this film");
    expect(abstained.map((item) => item.ruleId).sort()).toEqual([
      "coverage.consecutive-same-shot",
      "coverage.line-without-person-coverage",
      "coverage.reestablish-on-location-change",
      "coverage.wide-before-first-close",
    ].sort());
    expect(JSON.stringify(report)).not.toContain("close-up of her face");
  });

  it("uses a spoken ledger line and does not invent a sung pace", () => {
    const shots = coverageShotsFromJob({
      shots: [{ index: 1, shotType: "medium", durationSeconds: 3 }],
      ledger: { spokenLines: [{ shot: 1, line: "one two three four five six" }] },
    });
    const fired = suggestionsFor(request(shots, { source: "job" }), "coverage.line-shorter-than-speech");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.evidence?.values.delivery).toBe("spoken");
    expect(fired[0]?.evidence?.values.deliverySource).toBe("spoken-ledger");
  });

  it("abstains when a caller line has no delivery", () => {
    const shots: CoverageShot[] = [{
      index: 1,
      shotType: "medium",
      locationId: "kitchen",
      durationSeconds: 3,
      line: { text: "one two three four five six" },
      lineSource: "caller",
    }];
    const fired = suggestionsFor(request(shots), "coverage.line-shorter-than-speech");
    expect(fired[0]?.abstention).toBe("line delivery not recorded");
    expect(fired[0]?.class).toBe("unverified");
  });

  it("matches plan_storyboard's ladder titles, including the repeated beat", () => {
    expect(ladderTitles(ladder, 6)).toEqual([
      "Establishing",
      "Character Intro",
      "Rising Action",
      "Rising Action 2",
      "Complication",
      "Resolution",
    ]);
  });

  it("F2: normalises known labels and abstains on movement-only or unknown ones", () => {
    const kitchen = (shotType: string, index = 1): CoverageShot => ({
      index,
      shotType,
      locationId: "kitchen",
      durationSeconds: 8,
    });
    const line = (shotType: string): CoverageShot => ({
      ...kitchen(shotType),
      line: { text: "Hello there", delivery: "spoken" },
    });

    const extremeWide = suggestionsFor(request([
      kitchen("extreme wide"),
      { index: 2, shotType: "MCU", locationId: "kitchen", durationSeconds: 8 },
    ]), "coverage.wide-before-first-close");
    expect(extremeWide.filter((item) => item.class === "measured")).toEqual([]);

    const hyphenated = suggestionsFor(request([
      kitchen("Extreme-Wide"),
      { index: 2, shotType: "medium close-up", locationId: "kitchen", durationSeconds: 8 },
    ]), "coverage.wide-before-first-close");
    expect(hyphenated.filter((item) => item.class === "measured")).toEqual([]);

    const person = suggestionsFor(request([line("medium close-up")]), "coverage.line-without-person-coverage");
    expect(person.filter((item) => item.class === "measured")).toEqual([]);
    const mcu = suggestionsFor(request([line("MCU")]), "coverage.line-without-person-coverage");
    expect(mcu.filter((item) => item.class === "measured")).toEqual([]);

    const tracking = suggestionsFor(request([
      kitchen("wide", 1),
      { index: 2, shotType: "tracking", locationId: "hall", durationSeconds: 8 },
    ]), "coverage.reestablish-on-location-change");
    expect(tracking.filter((item) => item.class === "measured")).toEqual([]);
    expect(tracking[0]?.abstention).toBe("shot type not in the rule's vocabulary");

    for (const label of ["dolly", "pan", "not-a-real-shot"]) {
      const result = suggestionsFor(request([line(label)]), "coverage.line-without-person-coverage");
      expect(result.filter((item) => item.class === "measured"), label).toEqual([]);
      expect(result[0]?.abstention, label).toBe("shot type not in the rule's vocabulary");
    }

    const sameClass = suggestionsFor(request([
      kitchen("wide", 1),
      kitchen("establishing", 2),
      kitchen("EWS", 3),
    ]), "coverage.consecutive-same-shot");
    expect(sameClass).toHaveLength(1);
    expect(sameClass[0]?.class).toBe("measured");
    expect(sameClass[0]?.evidence?.values.shotType).toBe("wide");
  });

  it("framing wins over shotType", () => {
    const framed = suggestionsFor(request([{
      index: 1,
      framing: "wide",
      shotType: "close-up",
      locationId: "kitchen",
      durationSeconds: 8,
    }]), "coverage.wide-before-first-close");
    expect(framed.filter((item) => item.class === "measured")).toEqual([]);
    const shotWinsIfNoFraming = suggestionsFor(request([{
      index: 1,
      shotType: "close-up",
      locationId: "kitchen",
      durationSeconds: 8,
    }]), "coverage.wide-before-first-close");
    expect(shotWinsIfNoFraming.filter((item) => item.class === "measured")).toHaveLength(1);
  });

  it("a line that fits exactly does not fire, and one second under does", () => {
    const exact = suggestionsFor(request([{
      index: 1,
      shotType: "medium",
      locationId: "kitchen",
      durationSeconds: 4,
      line: { text: "one two three four five six", delivery: "spoken" },
    }]), "coverage.line-shorter-than-speech");
    expect(exact).toEqual([]);
    const short = suggestionsFor(request([{
      index: 1,
      shotType: "medium",
      locationId: "kitchen",
      durationSeconds: 3,
      line: { text: "one two three four five six", delivery: "spoken" },
    }]), "coverage.line-shorter-than-speech");
    expect(short).toHaveLength(1);
  });

  it("a sung line uses the sung pace", () => {
    const words = "one two three four five six seven eight nine ten";
    const sung = suggestionsFor(request([{
      index: 1,
      shotType: "medium",
      locationId: "kitchen",
      durationSeconds: 4,
      line: { text: words, delivery: "sung" },
    }]), "coverage.line-shorter-than-speech");
    expect(sung).toHaveLength(1);
    expect(sung[0]?.evidence?.values.delivery).toBe("sung");
    expect(sung[0]?.evidence?.values.neededSeconds).toBe(5);
    const spoken = suggestionsFor(request([{
      index: 1,
      shotType: "medium",
      locationId: "kitchen",
      durationSeconds: 4,
      line: { text: words, delivery: "spoken" },
    }]), "coverage.line-shorter-than-speech");
    expect(spoken).toEqual([]);
  });

  it("P04: shots with lines and no shot type abstain once as a group", () => {
    const shots: CoverageShot[] = [
      { index: 1, locationId: "kitchen", durationSeconds: 8, line: { text: "Hello there", delivery: "spoken" } },
      { index: 2, locationId: "kitchen", durationSeconds: 8, line: { text: "Goodbye friend", delivery: "spoken" } },
    ];
    const result = suggestionsFor(request(shots), "coverage.line-without-person-coverage");
    expect(result).toHaveLength(1);
    expect(result[0]?.class).toBe("unverified");
    expect(result[0]?.abstention).toBe("shot type was not supplied");
    expect(result[0]?.shots).toEqual([1, 2]);
    expect(result.filter((item) => item.class === "measured")).toEqual([]);
  });

  it("gives every suggestion evidence or an abstention and never a spend field", () => {
    const report = suggestCoverage(request([
      { index: 1, shotType: "close", locationId: "kitchen", durationSeconds: 16, line: { text: "Hello there friend of mine today", delivery: "sung" } },
      { index: 2, shotType: "close", locationId: "hall", durationSeconds: 16 },
      { index: 3, shotType: "close", locationId: "hall", durationSeconds: 16 },
    ], { targetDurationSeconds: 4, usedBuiltInLadder: true }));
    expect(report.suggestions.length).toBeGreaterThan(0);
    for (const item of report.suggestions) {
      expect(item.evidence || item.abstention).toBeTruthy();
      expect(item.wouldSpend).toBe(false);
    }
    expect(spendKeys(report)).toEqual([]);
    const ids = new Set(report.suggestions.map((item) => item.ruleId));
    const known: readonly CoverageRuleId[] = [
      "coverage.wide-before-first-close",
      "coverage.consecutive-same-shot",
      "coverage.reestablish-on-location-change",
      "coverage.line-shorter-than-speech",
      "coverage.line-without-person-coverage",
      "structure.ladder-order",
      "pacing.total-duration",
      "pacing.shot-exceeds-renderer-max",
    ];
    for (const id of ids) expect(known).toContain(id);
  });
});

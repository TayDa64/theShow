import { describe, expect, it } from "vitest";
import { quoteFingerprint } from "../mcp/costGate.ts";
import {
  approveRepairOption,
  buildDependencyGraph,
  proposeRepair,
  type DependencyShot,
} from "../mcp/repairPlan.ts";

const chained: DependencyShot[] = [
  { index: 1, durationSeconds: 6, pin: "start", framePath: "/f/1-last.png" },
  {
    index: 2,
    durationSeconds: 8,
    pin: "both",
    firstFramePath: "/f/1-last.png",
    lastFramePath: "/f/board-2.png",
    framePath: "/f/2-last.png",
    boardStillPaths: ["/f/board-2.png"],
    extendedFrom: "/f/2-base.mp4",
  },
  {
    index: 3,
    durationSeconds: 6,
    pin: "both",
    firstFramePath: "/f/board-2.png",
    lastFramePath: "/f/board-3.png",
  },
];

describe("dependency-aware repair", () => {
  it("records seeds, a both-end pin, a board still, and an extension", () => {
    const graph = buildDependencyGraph(chained);
    expect(graph.version).toBe(1);
    expect(graph.nodes.find((node) => node.shot === 2)).toMatchObject({
      pin: "both",
      seededByShot: 1,
      extendedFrom: "/f/2-base.mp4",
      boardStills: ["/f/board-2.png"],
    });
    expect(graph.nodes.find((node) => node.shot === 3)?.seededByShot).toBe(2);
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromShot: 1, toShot: 2, kind: "last-frame-seed", artifact: "/f/1-last.png", verified: true },
      { fromShot: 2, toShot: 3, kind: "board-still", artifact: "/f/board-2.png", verified: true },
      { fromShot: 2, toShot: 2, kind: "extension", artifact: "/f/2-base.mp4", verified: true },
    ]));
  });

  it("prices repair options with cost, fixes, and what stays broken, and does not run them", () => {
    const graph = buildDependencyGraph(chained);
    const proposal = proposeRepair({ graph, badShot: 2, resolution: "720p" });
    expect(proposal.executed).toBe(false);
    expect(proposal.willRender).toBe(false);
    expect(proposal.willSpend).toBe(false);

    const byId = Object.fromEntries(proposal.options.map((option) => [option.id, option]));
    expect(byId["retry-alone"]).toMatchObject({
      costUsd: 1.12,
      shotsToRender: [2],
      stillsToBuy: 0,
      requiresApproval: true,
    });
    expect(byId["retry-alone"].fixes.join(" ")).toMatch(/shot 2/);
    expect(byId["retry-alone"].leavesBroken.join(" ")).toMatch(/pinned boundary/);
    expect(byId["retry-alone"].leavesBroken.join(" ")).not.toMatch(/hard cut/);

    expect(byId["retry-dependents"]).toMatchObject({
      costUsd: 1.12,
      shotsToRender: [2],
    });
    expect(byId["retry-dependents"].fixes.join(" ")).toMatch(/shot 2/);
    expect(byId["retry-dependents"].shotsToRender).not.toContain(3);
    expect(byId["retry-dependents"].leavesBroken.join(" ")).toMatch(/2-base\.mp4/);

    expect(byId["reboard-boundary"]).toMatchObject({
      costUsd: 1.98,
      stillsToBuy: 1,
      shotsToRender: [2, 3],
    });
    expect(byId["reboard-boundary"].fixes.join(" ")).toMatch(/board-2\.png/);
    expect(byId["reboard-boundary"].leavesBroken).toEqual([]);

    expect(byId["accept-note"]).toMatchObject({ costUsd: 0, shotsToRender: [], stillsToBuy: 0 });
    expect(byId["accept-note"].fixes).toEqual([]);
    expect(byId["accept-note"].leavesBroken.join(" ")).toMatch(/stays as rendered/);

    expect(proposal.options.map((option) => option.costUsd)).toEqual([...proposal.options.map((option) => option.costUsd)].sort((a, b) => a - b));
  });

  it("does not price an unrecorded link as a real seed", () => {
    const graph = buildDependencyGraph([
      { index: 1, durationSeconds: 8, pin: "both", framesRecorded: false },
      { index: 2, durationSeconds: 8, pin: "both", framesRecorded: false, lastFramePath: "/f/board.png" },
    ]);
    expect(graph.edges).toEqual([
      { fromShot: 1, toShot: 2, kind: "inferred", verified: false },
    ]);
    const proposal = proposeRepair({ graph, badShot: 1, resolution: "720p" });
    const dependents = proposal.options.find((option) => option.id === "retry-dependents");
    expect(dependents?.costUsd).toBe(1.12);
    expect(dependents?.shotsToRender).toEqual([1]);
    const alone = proposal.options.find((option) => option.id === "retry-alone");
    expect(alone?.leavesBroken.join(" ")).toMatch(/unverified/);
    expect(alone?.leavesBroken.join(" ")).toMatch(/cut/);
    expect(alone?.costUsd).toBe(1.12);
  });

  it("does not execute a strategy without an approval, and a mismatched quote does not run it either", () => {
    const graph = buildDependencyGraph(chained);
    const proposal = proposeRepair({ graph, badShot: 2, resolution: "720p" });
    const option = proposal.options.find((entry) => entry.id === "retry-alone");
    if (!option) throw new Error("missing retry-alone");
    const fingerprint = quoteFingerprint({ strategy: option.id, shots: option.shotsToRender, usd: option.costUsd });

    const unapproved = approveRepairOption({ option, fingerprint, confirm: false, overrideValidation: true });
    expect(unapproved.decision).toBe("estimate");
    expect(unapproved.executed).toBe(false);
    expect(unapproved.willRender).toBe(false);

    const stale = approveRepairOption({
      option,
      fingerprint,
      confirm: true,
      overrideValidation: true,
      approvedKind: "retry",
      approvedUsd: 0.02,
      approvedFingerprint: "board-quote",
    });
    expect(stale.decision).toBe("refused");
    expect(stale.executed).toBe(false);
    expect(stale.willSpend).toBe(false);

    const approved = approveRepairOption({
      option,
      fingerprint,
      confirm: true,
      approvedKind: "retry",
      approvedUsd: option.costUsd,
      approvedFingerprint: fingerprint,
    });
    expect(approved.decision).toBe("spend");
    expect(approved.executed).toBe(false);
    expect(approved.willRender).toBe(false);
    expect(approved.willSpend).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewContinuity, type ReviewShot } from "../mcp/continuityReview.ts";

const hanger = { id: "hanger", locationId: "room", placement: "on the wall" };

function shots(): ReviewShot[] {
  return [
    {
      index: 1,
      worn: ["coat", "shirt"],
      props: [hanger],
      lastFramePath: "/frames/1-last.png",
      referencePath: "/frames/ref.png",
      durationSeconds: 6,
    },
    {
      index: 2,
      worn: ["shirt"],
      props: [{ ...hanger, holder: "ada" }],
      firstFramePath: "/frames/2-first.png",
      referencePath: "/frames/ref.png",
      durationSeconds: 8,
    },
  ];
}

describe("continuity review classification", () => {
  it("classifies each boundary finding and keeps evidence or an abstention", () => {
    const present = new Set(["/frames/1-last.png", "/frames/2-first.png", "/frames/ref.png"]);
    const review = reviewContinuity({
      shots: shots(),
      ledgerArtifact: "job:seq#ledger",
      styleNotes: ["cinematic teal grade"],
      narrativeSuggestions: ["he should confess in the doorway"],
      measurements: [{
        afterShot: 1,
        agreement: 0.99,
        method: "made-up",
        meanLumaDelta: 0.1,
        identityAgreement: 0.97,
        source: "caller",
      }],
      fileExists: (file) => present.has(file),
      resolution: "720p",
    });

    const byTopic = Object.fromEntries(review.findings.map((finding) => [finding.topic, finding]));
    expect(byTopic.wardrobe.class).toBe("measured");
    expect(byTopic.wardrobe.evidence).toMatchObject({
      method: "ledger-worn-diff",
      value: "changed",
      artifactPaths: ["job:seq#ledger"],
    });
    expect(byTopic.props.class).toBe("measured");
    expect(byTopic.props.evidence?.value).toBe("changed");
    expect(byTopic.pose.class).toBe("unverified");
    expect(byTopic.pose.abstention).toMatch(/Caller-reported/);
    expect(byTopic.lighting.class).toBe("unverified");
    expect(byTopic.identity.class).toBe("unverified");
    expect(byTopic.identity.abstention).toMatch(/Caller-reported/);

    for (const finding of review.findings) {
      const evidenced = Boolean(finding.evidence?.method) && Array.isArray(finding.evidence?.artifactPaths);
      const abstained = typeof finding.abstention === "string" && finding.abstention.length > 0;
      expect(evidenced || abstained).toBe(true);
      if (finding.class === "unverified") expect(finding.abstention).toBeTruthy();
      if (finding.class === "measured") expect(finding.evidence?.value).toBeDefined();
      if (finding.class === "visually-flagged") expect(finding.evidence?.value).toBeUndefined();
    }

    const dumped = JSON.stringify(review.findings);
    expect(dumped).not.toContain("cinematic teal grade");
    expect(dumped).not.toContain("he should confess");
    expect(review.executed).toBe(false);
    expect(review.willRender).toBe(false);
    expect(review.willSpend).toBe(false);
    expect(review.mutatedPaths).toEqual([]);
    expect(review.repairProposal).toBeUndefined();
  });

  it("does not treat a planned wardrobe change as a defect", () => {
    const review = reviewContinuity({
      shots: shots(),
      plannedShots: [2],
      fileExists: () => false,
    });
    const wardrobe = review.findings.find((finding) => finding.topic === "wardrobe");
    expect(wardrobe?.class).toBe("measured");
    expect(wardrobe?.planned).toBe(true);
    expect(review.repairProposal).toBeUndefined();
  });

  it("measures identity only when the files on disk match", async () => {
    const dir = path.join(tmpdir(), `theshow-same-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const frame = path.join(dir, "frame.png");
    const reference = path.join(dir, "reference.png");
    await writeFile(frame, "same-bytes");
    await writeFile(reference, "same-bytes");
    const review = reviewContinuity({
      shots: [
        { index: 1, worn: ["coat"], props: [hanger], lastFramePath: frame },
        { index: 2, worn: ["coat"], props: [hanger], firstFramePath: reference, referencePath: reference },
      ],
      fileExists: () => true,
      filesIdentical: (left, right) => readFileSync(left).equals(readFileSync(right)),
    });
    const identity = review.findings.find((finding) => finding.topic === "identity");
    expect(identity?.class).toBe("measured");
    expect(identity?.evidence?.method).toBe("sha256-identity");
  });

  it("flags seam frames that exist and were not measured", () => {
    const review = reviewContinuity({
      shots: shots().map((shot) => ({ ...shot, worn: undefined, props: undefined, durationSeconds: undefined })),
      fileExists: () => true,
    });
    const pose = review.findings.find((finding) => finding.topic === "pose");
    expect(pose?.class).toBe("visually-flagged");
    expect(pose?.evidence?.artifactPaths).toEqual(["/frames/1-last.png", "/frames/2-first.png"]);
    expect(pose?.evidence?.value).toBeUndefined();
    expect(review.findings.find((finding) => finding.topic === "lighting")?.class).toBe("unverified");
    expect(review.findings.find((finding) => finding.topic === "wardrobe")?.class).toBe("unverified");
  });

  it("abstains when the frames are not on disk", () => {
    const review = reviewContinuity({
      shots: shots(),
      fileExists: () => false,
      measurements: [{ afterShot: 1, agreement: 0.99 }],
    });
    const pose = review.findings.find((finding) => finding.topic === "pose");
    expect(pose?.class).toBe("unverified");
    expect(pose?.abstention).toMatch(/missing on disk/);
    expect(pose?.evidence?.value).toBeUndefined();
  });

  it("does not invent a boundary inside a single shot", () => {
    const review = reviewContinuity({
      shots: [shots()[0]],
      styleNotes: ["push the grade"],
    });
    expect(review.findings).toEqual([]);
  });

  it("does not write, delete, or reorder files", async () => {
    const dir = path.join(tmpdir(), `theshow-review-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.png"), "frame-a");
    await writeFile(path.join(dir, "b.png"), "frame-b");
    const before = await readdir(dir);
    const review = reviewContinuity({
      shots: [
        { index: 1, worn: ["coat"], props: [hanger], lastFramePath: path.join(dir, "a.png") },
        { index: 2, worn: ["shirt"], props: [hanger], firstFramePath: path.join(dir, "b.png") },
      ],
      fileExists: () => true,
      styleNotes: ["delete the coat file"],
    });
    expect(await readdir(dir)).toEqual(before);
    expect(review.mutatedPaths).toEqual([]);
    expect(review.willRender).toBe(false);
  });
});

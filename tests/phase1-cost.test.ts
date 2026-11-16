import { describe, expect, it } from "vitest";
import { STILL_USD } from "../mcp/storyboard.ts";
import {
  STILL_QUOTE_USD,
  VIDEO_USD_PER_SECOND,
  assessBudget,
  authorizeSpend,
  gatePaidAction,
  videoQuote,
} from "../mcp/costGate.ts";

describe("explicit cost gates", () => {
  it("keeps the measured still and video rates", () => {
    expect(STILL_QUOTE_USD).toBe(STILL_USD);
    expect(STILL_QUOTE_USD).toBe(0.02);
    expect(VIDEO_USD_PER_SECOND).toEqual({ "480p": 0.08, "720p": 0.14, "1080p": 0.25 });
  });

  it("does not let a board approval authorize video, or the reverse", () => {
    const board = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const video = authorizeSpend({
      kind: "video",
      usd: board.usd,
      fingerprint: board.fingerprint,
      confirm: true,
      approvedKind: "board",
      approvedUsd: board.usd,
      approvedFingerprint: board.fingerprint,
    });
    expect(video.decision).toBe("refused");
    expect(video.reason).toMatch(/board approval does not authorize a video/);

    const still = authorizeSpend({
      kind: "board",
      usd: STILL_QUOTE_USD,
      fingerprint: "board-fp",
      confirm: true,
      approvedKind: "video",
      approvedUsd: STILL_QUOTE_USD,
      approvedFingerprint: "board-fp",
    });
    expect(still.decision).toBe("refused");
    expect(still.reason).toMatch(/video approval does not authorize a board/);
  });

  it("invalidates a confirm when the estimate changes", () => {
    const quoted = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const changed = videoQuote({ resolution: "1080p", pin: "start", durations: [8] });
    expect(quoted.usd).toBe(1.12);
    expect(changed.usd).toBe(2);
    expect(quoted.fingerprint).not.toBe(changed.fingerprint);

    const stale = authorizeSpend({
      kind: "video",
      usd: changed.usd,
      fingerprint: changed.fingerprint,
      confirm: true,
      approvedKind: "video",
      approvedUsd: quoted.usd,
      approvedFingerprint: quoted.fingerprint,
    });
    expect(stale.decision).toBe("refused");
    expect(stale.reason).toMatch(/estimate changed/i);

    const current = authorizeSpend({
      kind: "video",
      usd: changed.usd,
      fingerprint: changed.fingerprint,
      confirm: true,
      approvedKind: "video",
      approvedUsd: changed.usd,
      approvedFingerprint: changed.fingerprint,
    });
    expect(current.decision).toBe("spend");
  });

  it("warns on a cumulative budget and never authorizes from that warning", () => {
    const under = assessBudget({ spentUsd: 1, pendingUsd: 1, thresholdUsd: 3 });
    expect(under.crossed).toBe(false);
    expect(under.authorizesSpend).toBe(false);

    const over = assessBudget({ spentUsd: 3.44, pendingUsd: 1.12, thresholdUsd: 4 });
    expect(over.crossed).toBe(true);
    expect(over.totalUsd).toBe(4.56);
    expect(over.warning).toMatch(/does not authorize/);
    expect(over.authorizesSpend).toBe(false);

    const gated = gatePaidAction({
      kind: "video",
      usd: 1.12,
      fingerprint: "pending",
      confirm: false,
      budgetUsd: 4,
      spentUsd: 3.44,
    });
    expect(gated.decision).toBe("estimate");
    expect(gated.authorizesSpend).toBe(false);
    expect(gated.budgetWarning).toMatch(/over the/);
  });

  it("refuses a partial quote and spends a bare confirm with the quote named", () => {
    const quoted = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const usdOnly = authorizeSpend({
      kind: "video",
      usd: quoted.usd,
      fingerprint: quoted.fingerprint,
      confirm: true,
      approvedUsd: quoted.usd,
    });
    expect(usdOnly.decision).toBe("refused");
    expect(usdOnly.reason).toMatch(/approvedKind, approvedUsd, and approvedFingerprint/);

    const kindOnly = authorizeSpend({
      kind: "video",
      usd: quoted.usd,
      fingerprint: quoted.fingerprint,
      confirm: true,
      approvedKind: "video",
    });
    expect(kindOnly.decision).toBe("refused");

    const swapped = videoQuote({ resolution: "720p", pin: "start", durations: [5, 3] });
    const original = videoQuote({ resolution: "720p", pin: "start", durations: [3, 5] });
    expect(swapped.usd).toBe(original.usd);
    expect(swapped.fingerprint).not.toBe(original.fingerprint);
    const reordered = authorizeSpend({
      kind: "video",
      usd: swapped.usd,
      fingerprint: swapped.fingerprint,
      confirm: true,
      approvedKind: "video",
      approvedUsd: original.usd,
      approvedFingerprint: original.fingerprint,
    });
    expect(reordered.decision).toBe("refused");

    const bare = gatePaidAction({
      kind: "video",
      usd: quoted.usd,
      fingerprint: quoted.fingerprint,
      confirm: true,
      budgetUsd: 0,
      spentUsd: 3,
    });
    expect(bare.decision).toBe("spend");
    expect(bare.authorizesSpend).toBe(true);
    expect(bare.unboundApproval?.approvedFingerprint).toBe(quoted.fingerprint);
    expect(bare.unboundApproval?.approvedKind).toBe("video");
    expect(bare.unboundApproval?.approvedUsd).toBe(quoted.usd);
    expect(bare.budgetWarning).toMatch(/does not authorize/);
  });

  it("does not let overrideValidation skip cost confirmation", () => {
    const quoted = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const withoutConfirm = authorizeSpend({
      kind: "video",
      usd: quoted.usd,
      fingerprint: quoted.fingerprint,
      confirm: false,
      overrideValidation: true,
      approvedKind: "video",
      approvedUsd: quoted.usd,
      approvedFingerprint: quoted.fingerprint,
    });
    expect(withoutConfirm.decision).toBe("estimate");

    const changed = videoQuote({ resolution: "1080p", pin: "both", durations: [8, 8] });
    const overridden = authorizeSpend({
      kind: "video",
      usd: changed.usd,
      fingerprint: changed.fingerprint,
      confirm: true,
      overrideValidation: true,
      approvedKind: "video",
      approvedUsd: quoted.usd,
      approvedFingerprint: quoted.fingerprint,
    });
    expect(overridden.decision).toBe("refused");
    expect(overridden.reason).toMatch(/estimate changed/i);
  });

  it("does not let a budget warning change a spend into a refusal", () => {
    const approved = gatePaidAction({
      kind: "video",
      usd: 2,
      fingerprint: "go",
      confirm: true,
      approvedKind: "video",
      approvedUsd: 2,
      approvedFingerprint: "go",
      budgetUsd: 1,
      spentUsd: 3,
    });
    expect(approved.decision).toBe("spend");
    expect(approved.authorizesSpend).toBe(true);
    expect(approved.budgetWarning).toMatch(/does not authorize/);
    expect(approved.unboundApproval).toBeUndefined();
  });
});

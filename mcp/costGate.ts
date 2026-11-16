/**
 * Explicit cost quotes.
 *
 * A board approval and a video approval are different quotes. Confirm spends
 * only the quote it names. overrideValidation does not stand in for confirm.
 * A film budget warns when spent plus pending crosses it, and never spends
 * or stops a render that has already been approved.
 */

import { createHash } from "node:crypto";

export const STILL_QUOTE_USD = 0.02;

export const VIDEO_USD_PER_SECOND = {
  "480p": 0.08,
  "720p": 0.14,
  "1080p": 0.25,
} as const;

export type VideoResolution = keyof typeof VIDEO_USD_PER_SECOND;

export const SPEND_KINDS = ["board", "video", "still", "extend", "retry"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export type SpendQuote = {
  version: 1;
  kind: SpendKind;
  usd: number;
  fingerprint: string;
};

export type SpendDecision = "estimate" | "refused" | "spend";

export type AuthorizeInput = {
  kind: SpendKind;
  usd: number;
  fingerprint: string;
  confirm: boolean;
  approvedUsd?: number;
  approvedKind?: SpendKind;
  approvedFingerprint?: string;
  /** Accepted so callers can pass it. It never authorizes a spend. */
  overrideValidation?: boolean;
};

export type AuthorizeResult = {
  decision: SpendDecision;
  quote: SpendQuote;
  reason?: string;
};

export type BudgetAssessment = {
  version: 1;
  spentUsd: number;
  pendingUsd: number;
  totalUsd: number;
  thresholdUsd?: number;
  crossed: boolean;
  warning?: string;
  /** A budget check never authorizes a paid call. */
  authorizesSpend: false;
};

export type SpendEntry = {
  kind: SpendKind;
  usd: number;
};

export type PersistedSpend = {
  version: 1;
  thresholdUsd?: number;
  spentUsd: number;
  pendingUsd: number;
  entries?: SpendEntry[];
};

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function usdEqual(left: number, right: number): boolean {
  return roundUsd(left) === roundUsd(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function quoteFingerprint(material: unknown): string {
  return createHash("sha256").update(stableStringify(material)).digest("hex").slice(0, 16);
}

export function videoQuote(input: {
  resolution: string;
  pin: "start" | "both";
  durations: number[];
  prompts?: string[];
  continuity?: string;
  model?: string;
  aspectRatio?: string;
  firstFrames?: Array<string | undefined>;
  lastFrames?: Array<string | undefined>;
}): { usd: number; fingerprint: string } {
  const rate = VIDEO_USD_PER_SECOND[input.resolution as VideoResolution] ?? VIDEO_USD_PER_SECOND["720p"];
  const usd = roundUsd(input.durations.reduce((sum, duration) => sum + duration * rate, 0));
  const fingerprint = quoteFingerprint({
    kind: "video",
    resolution: input.resolution,
    pin: input.pin,
    durations: input.durations,
    shotCount: input.durations.length,
    ...(input.prompts ? { prompts: input.prompts } : {}),
    ...(input.continuity !== undefined ? { continuity: input.continuity } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.firstFrames ? { firstFrames: input.firstFrames } : {}),
    ...(input.lastFrames ? { lastFrames: input.lastFrames } : {}),
  });
  return { usd, fingerprint };
}

export function hasCostAnnotation(input: {
  approvedUsd?: number;
  approvedKind?: SpendKind;
  approvedFingerprint?: string;
  budgetUsd?: number;
}): boolean {
  return input.approvedUsd !== undefined
    || input.approvedKind !== undefined
    || input.approvedFingerprint !== undefined
    || input.budgetUsd !== undefined;
}

export function quoteFieldsPresent(input: {
  approvedUsd?: number;
  approvedKind?: SpendKind;
  approvedFingerprint?: string;
}): boolean {
  return input.approvedUsd !== undefined
    || input.approvedKind !== undefined
    || input.approvedFingerprint !== undefined;
}

export function authorizeSpend(input: AuthorizeInput): AuthorizeResult {
  const quote: SpendQuote = {
    version: 1,
    kind: input.kind,
    usd: roundUsd(input.usd),
    fingerprint: input.fingerprint,
  };
  // Confirm is the cost gate. overrideValidation is not read here.
  // budgetUsd is not an approval field and cannot reach this function as one.
  if (!input.confirm) {
    return { decision: "estimate", quote };
  }
  const namedKind = input.approvedKind !== undefined;
  const namedUsd = input.approvedUsd !== undefined;
  const namedFingerprint = input.approvedFingerprint !== undefined;
  if (namedKind || namedUsd || namedFingerprint) {
    if (!namedKind || !namedUsd || !namedFingerprint) {
      return {
        decision: "refused",
        quote,
        reason: "A confirm that names part of a quote has to include approvedKind, approvedUsd, and approvedFingerprint. The partial confirm was refused.",
      };
    }
    if (input.approvedKind !== input.kind) {
      return {
        decision: "refused",
        quote,
        reason: `A ${input.approvedKind} approval does not authorize a ${input.kind} spend.`,
      };
    }
    if (!usdEqual(input.approvedUsd ?? 0, input.usd)) {
      return {
        decision: "refused",
        quote,
        reason: "The estimate changed. The earlier confirm is not valid for this quote.",
      };
    }
    if (input.approvedFingerprint !== input.fingerprint) {
      return {
        decision: "refused",
        quote,
        reason: "The estimate changed. The earlier confirm is not valid for this quote.",
      };
    }
  }
  return { decision: "spend", quote };
}

export type UnboundApproval = {
  warning: string;
  approvedKind: SpendKind;
  approvedUsd: number;
  approvedFingerprint: string;
};

/** Bare confirm spends. The response names the quote it actually used. */
export function unboundApproval(input: {
  confirm: boolean;
  approvedUsd?: number;
  approvedKind?: SpendKind;
  approvedFingerprint?: string;
}, quote: SpendQuote): UnboundApproval | undefined {
  if (!input.confirm || quoteFieldsPresent(input)) return undefined;
  return {
    warning:
      `confirm was not bound to a quote. This spend uses approvedKind ${quote.kind}, ` +
      `approvedUsd ${quote.usd}, approvedFingerprint ${quote.fingerprint}.`,
    approvedKind: quote.kind,
    approvedUsd: quote.usd,
    approvedFingerprint: quote.fingerprint,
  };
}

export function assessBudget(input: {
  spentUsd: number;
  pendingUsd: number;
  thresholdUsd?: number;
}): BudgetAssessment {
  const spentUsd = roundUsd(input.spentUsd);
  const pendingUsd = roundUsd(input.pendingUsd);
  const totalUsd = roundUsd(spentUsd + pendingUsd);
  const thresholdUsd = input.thresholdUsd;
  const crossed = thresholdUsd !== undefined && totalUsd > roundUsd(thresholdUsd) + 1e-9;
  const warning = crossed
    ? `Spent $${spentUsd.toFixed(2)} plus a pending $${pendingUsd.toFixed(2)} is $${totalUsd.toFixed(2)}, over the $${roundUsd(thresholdUsd ?? 0).toFixed(2)} film budget. This warning does not authorize spending.`
    : undefined;
  return {
    version: 1,
    spentUsd,
    pendingUsd,
    totalUsd,
    ...(thresholdUsd !== undefined ? { thresholdUsd: roundUsd(thresholdUsd) } : {}),
    crossed,
    ...(warning ? { warning } : {}),
    authorizesSpend: false,
  };
}

export type PaidAction = {
  decision: SpendDecision;
  quote: SpendQuote;
  reason?: string;
  budgetWarning?: string;
  authorizesSpend: boolean;
  unboundApproval?: UnboundApproval;
};

export function gatePaidAction(input: AuthorizeInput & {
  spentUsd?: number;
  budgetUsd?: number;
}): PaidAction {
  const auth = authorizeSpend(input);
  const budget = assessBudget({
    spentUsd: input.spentUsd ?? 0,
    pendingUsd: input.usd,
    thresholdUsd: input.budgetUsd,
  });
  const unbound = unboundApproval(input, auth.quote);
  return {
    decision: auth.decision,
    quote: auth.quote,
    ...(auth.reason ? { reason: auth.reason } : {}),
    ...(budget.warning ? { budgetWarning: budget.warning } : {}),
    authorizesSpend: auth.decision === "spend",
    ...(unbound ? { unboundApproval: unbound } : {}),
  };
}

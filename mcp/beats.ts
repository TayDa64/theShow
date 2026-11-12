/**
 * Per-beat timing and framing.
 *
 * Omitted fields keep the old ladder: shot 1 is wide, every later shot is
 * medium, and a supplied beat list splits the film evenly. A framing, a
 * duration, or a spoken line is used only when the beat actually carries it.
 */

export type BeatTiming = {
  framing?: string;
  shotType?: string;
  durationSeconds?: number;
  line?: { text?: string; delivery?: "spoken" | "sung" };
};

export function resolveBeatShotType(beat: BeatTiming, index: number): string {
  const named = beat.framing?.trim() || beat.shotType?.trim();
  if (named) return named;
  return index === 0 ? "wide" : "medium";
}

/**
 * A sung line is about two words a second and a spoken line about three,
 * with a floor of four seconds so a short line still has time to be acted.
 */
export function durationFromLine(text: string, delivery: "spoken" | "sung" = "spoken"): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wordsPerSecond = delivery === "sung" ? 2 : 3;
  return Math.min(15, Math.max(4, Math.ceil(words / wordsPerSecond)));
}

export function resolveBeatDuration(beat: BeatTiming, evenSplitSeconds: number): number {
  if (typeof beat.durationSeconds === "number" && Number.isFinite(beat.durationSeconds)) {
    return Math.min(15, Math.max(1, Math.round(beat.durationSeconds)));
  }
  const line = beat.line?.text?.trim();
  if (line) return durationFromLine(line, beat.line?.delivery === "sung" ? "sung" : "spoken");
  return evenSplitSeconds;
}

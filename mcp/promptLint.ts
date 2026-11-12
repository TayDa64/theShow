/**
 * Off-prompt admission for text that must never be sent to Grok.
 *
 * Grok Imagine has no negative_prompt field. Forbidden nouns and negation are
 * rejected here, before any paid call. A separate negative list is stored for
 * this lint and for the post-generation checklist. It is not a request field.
 */

export type LintHit = {
  kind: "forbidden" | "negation" | "negative";
  match: string;
};

/**
 * Known model limits and hallucinations. Phrases are matched as written.
 * Bare words use a boundary so "lamplight" and "tied" stay legal.
 */
const FORBIDDEN: RegExp[] = [
  /floor lamp/i,
  /table lamp/i,
  /amber lamp/i,
  /wall lamp/i,
  /\blamps?\b/i,
  /door handle/i,
  /\bhandle\b/i,
  /\bknob\b/i,
  /\blever\b/i,
  /\bpull\b/i,
  /door seals/i,
  /\bgasket\b/i,
  /weatherstripping/i,
  /\bhinged\b/i,
  /door's swing/i,
  /swings the door/i,
  /second doorway/i,
  /extra door/i,
  /\bno tie\b/i,
  /\btie\b/i,
  /\bsubtitles?\b/i,
  /\bcaptions?\b/i,
  /\bwatermark\b/i,
  /\blogos?\b/i,
  /\bmusic\b/i,
  /\bscore\b/i,
  /easy natural pace/i,
  /never sped/i,
];

const NEGATION =
  /\b(never|don't|do not|does not|didn't|avoid|nothing|without|n't)\b|\bno\b/i;

export function negativePhrases(negative: string | undefined): string[] {
  if (!negative?.trim()) return [];
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const part of negative.split(/[\n,]+/)) {
    const phrase = part.trim();
    if (phrase.length < 3) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  return phrases;
}

export function lintSentPrompt(prompt: string, negative?: string): LintHit[] {
  const hits: LintHit[] = [];
  for (const pattern of FORBIDDEN) {
    const found = pattern.exec(prompt);
    if (found) hits.push({ kind: "forbidden", match: found[0] });
  }
  const negation = NEGATION.exec(prompt);
  if (negation) hits.push({ kind: "negation", match: negation[0] });
  const haystack = prompt.toLowerCase();
  for (const phrase of negativePhrases(negative)) {
    if (haystack.includes(phrase.toLowerCase())) {
      hits.push({ kind: "negative", match: phrase });
    }
  }
  return hits;
}

export function lintFailure(
  prompt: string,
  negative?: string,
): { ok: true } | { ok: false; reason: string; hits: LintHit[] } {
  const hits = lintSentPrompt(prompt, negative);
  if (hits.length === 0) return { ok: true };
  const listed = hits.map((hit) => `${hit.kind} "${hit.match}"`).join(", ");
  return {
    ok: false,
    hits,
    reason: `Prompt rejected before any paid call: ${listed}. Say what is in the frame. The negative list stays off the request.`,
  };
}

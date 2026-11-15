/**
 * Splitting a cast line into the part a picture can prove and the part it can't.
 *
 * A board that is edited from a reference picture already carries the wardrobe
 * in pixels. Anything the cast TEXT says about clothing is therefore a second,
 * competing description of the same garment, and it loses: measured on a real
 * board, a cast line reading "...striped shirt under a tan sherpa-collar jacket
 * with a dark navy blazer beneath it" was edited from a portrait wearing the
 * coat alone, and across four frames the model demoted the coat to a sleeveless
 * vest and promoted the blazer that only the text had mentioned. The blazer was
 * never in the shot prompts; it entered through the cast description.
 *
 * Worse, the drift did not stop at the board. The bad frame was pinned as a
 * shot's last frame, so the clip interpolated a costume change partway through
 * the video, which reads as the prompt "starting to make things up" thirteen
 * seconds in. It was not the prompt; it was the frame it was handed.
 *
 * So when a picture is present, garment words are dropped from the cast and the
 * clothing is referred to by reference instead of by name. What stays is what a
 * face-recognition pass can check: head, hair, beard, skin, build.
 */

/**
 * Words that name something worn. Deliberately broad: dropping a garment that
 * the picture already shows costs nothing, while keeping one costs a re-roll or
 * a reshoot.
 */
const GARMENT =
  /\b(shirts?|blazers?|jackets?|coats?|suits?|ties?|necktie|bowtie|dress(?:es)?|gowns?|sweaters?|jumpers?|hoodies?|vests?|waistcoats?|trousers?|pants|jeans|shorts|skirts?|kilts?|robes?|capes?|cloaks?|parkas?|trench|sherpa|fleece|pullovers?|cardigans?|polos?|t-?shirts?|button-?downs?|henleys?|uniforms?|aprons?|overalls?|dungarees?|leggings?|tights|socks?|stockings?|shoes?|boots?|trainers|sneakers|loafers?|sandals?|heels|hats?|caps?|beanies?|berets?|helmets?|scar(?:f|ves)|gloves?|mittens?|belts?|suspenders?|braces|watches?|wristwatch|necklaces?|earrings?|bracelets?|rings?|glasses|spectacles|sunglasses|goggles|lapels?|cuffs?|collars?|sleeves?|hem|pockets?|buttons?|zippers?|pinstripes?|plaid|tartan|houndstooth|tweed|denim|corduroy|linen|silk|satin|leather|wool|cashmere|velvet|khaki|chinos|attire|outfit|wardrobe|clothing|clothes|dressed|wearing|dress shirt)\b/i;

/** Split a cast line into sentence-ish clauses, keeping the separators readable. */
export function castClauses(cast: string): string[] {
  return cast
    .split(/(?<=[.;])\s+|,\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function namesGarment(text: string): boolean {
  return GARMENT.test(text);
}

/**
 * Keep only the clauses a reference picture cannot disagree with: who the person
 * is, not what they have on.
 */
export function identityOnly(cast: string): string {
  const kept = castClauses(cast).filter((clause) => !namesGarment(clause));
  if (kept.length === 0) return "";
  return kept.join(", ").replace(/[,;]\s*$/, "").trim();
}

/**
 * The cast wording for a board that is edited from a picture.
 *
 * Clothing is never described here. It is named as belonging to the picture, so
 * there is exactly one source of truth for it and no adjective for the model to
 * build a second garment out of.
 */
export function castForPicture(cast: string | undefined): string {
  const identity = cast?.trim() ? identityOnly(cast) : "";
  const body = identity
    ? `THE CAST, taken from the reference picture and identical in every frame: ${identity}.`
    : "THE CAST, taken from the reference picture and identical in every frame: the person in it.";
  return (
    `${body} Their face, head, hair and skin are those of the reference picture: match them ` +
    `exactly. Their clothing is whatever the reference picture shows them wearing. Take the ` +
    `garments from the picture and copy them unchanged, in the same layers the picture shows. `
  );
}

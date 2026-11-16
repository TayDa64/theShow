/**
 * Child for the P39 tests. cwd holds a real file at the relative path Node
 * uses for the reference string. https://… becomes https:/… . A data: string
 * is used as the path, slashes included.
 */
import { saveCharacter, snapshotCharacter } from "../mcp/characters.ts";

const reference = process.env.N34_REFERENCE;
if (!reference) throw new Error("N34_REFERENCE is required");

const saved = await saveCharacter({
  name: "Remy",
  referenceImageUrls: [reference],
});
const snap = await snapshotCharacter("Remy");
process.stdout.write(`${JSON.stringify({
  stored: saved.referenceImageUrls,
  references: snap?.references ?? null,
})}\n`);

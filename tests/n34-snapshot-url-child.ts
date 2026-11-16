/**
 * Child for the P39 test. cwd is the temp directory that holds
 * `https:/example.test/remy.png`, which is the relative path Node uses for
 * `readFile("https://example.test/remy.png")`.
 */
import { saveCharacter, snapshotCharacter } from "../mcp/characters.ts";

const saved = await saveCharacter({
  name: "Remy",
  referenceImageUrls: ["https://example.test/remy.png"],
});
const snap = await snapshotCharacter("Remy");
process.stdout.write(`${JSON.stringify({
  stored: saved.referenceImageUrls,
  references: snap?.references ?? null,
})}\n`);

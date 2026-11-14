/**
 * One-shot worker for the multi-process lock and claim tests.
 * Invoked as `node --import tsx tests/mcp-multi-child.ts <mode> ...`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { saveCharacter } from "../mcp/characters.ts";
import { claimFilm } from "../mcp/server.ts";

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "save") {
    const [name, field, value] = rest;
    if (!name || !field || value === undefined) throw new Error("save needs name, field, value");
    if (field === "role") await saveCharacter({ name, role: value });
    else if (field === "description") await saveCharacter({ name, description: value });
    else if (field === "appearance") await saveCharacter({ name, appearance: value });
    else throw new Error(`unknown field ${field}`);
    return;
  }
  if (mode === "claim") {
    const id = rest[0];
    if (!id) throw new Error("claim needs a job id");
    const result = await claimFilm(id);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // Stay alive so a winner's pid is still live while the other claimers finish.
    await new Promise<void>((resolve) => {
      process.stdin.on("end", () => resolve());
      process.stdin.resume();
    });
    return;
  }
  throw new Error(`unknown mode ${mode ?? ""}`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().then(() => {
    process.exit(0);
  }, (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * Gaussian-feathered portrait cutout.
 *
 * The center stays opaque and the edges fall off, so a portrait's background
 * leaves the frame while the subject remains. This is a feather, not a learned
 * matte. The original file is only read. The cutout is a new PNG beside it.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";
import { resolveTools } from "./media";

const exec = promisify(execFile);

export async function featheredSubjectCutout(
  sourcePath: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const before = await readFile(sourcePath);
  const parsed = parse(sourcePath);
  const dest = join(dirname(sourcePath), `${parsed.name}.cutout.png`);
  if (dest === sourcePath) {
    return { ok: false, reason: "Cutout path collided with the original portrait." };
  }
  try {
    const { ffmpeg } = await resolveTools();
    // Sigma is a fraction of the width. The center exponent is 0 (opaque).
    // A corner of a square portrait lands near alpha 10, so the edge background
    // is gone and the subject in the middle is kept.
    const alpha =
      "255*exp(-((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2))/(2*(W*0.28)*(W*0.28)))";
    const filter =
      `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
    await exec(ffmpeg, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      filter,
      dest,
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Portrait cutout failed.",
    };
  }
  const after = await readFile(sourcePath);
  if (!after.equals(before)) {
    return { ok: false, reason: "Portrait cutout wrote the original file." };
  }
  return { ok: true, path: dest };
}

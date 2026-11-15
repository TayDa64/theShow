/**
 * One-shot worker for the multi-process lock and claim tests.
 * Invoked as `node --import tsx tests/mcp-multi-child.ts <mode> ...`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { saveCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { setBeforeRenameProbe, sweepOrphanTemps } from "../mcp/runtime.ts";
import { claimFilm, readPersistedJob, saveJobAnnotation } from "../mcp/server.ts";

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
  if (mode === "annotate-review" || mode === "annotate-repair") {
    const id = rest[0];
    if (!id) throw new Error("annotate needs a job id");
    if (process.env.THESHOW_PAUSE_BEFORE_RENAME === "1") {
      setBeforeRenameProbe(async () => {
        process.stdout.write("paused-before-rename\n");
        await new Promise(() => undefined);
      });
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const saved = await saveJobAnnotation(id, (job) => {
        if (mode === "annotate-review") {
          job.continuityReview = {
            version: 1,
            findings: [],
            executed: false,
            willRender: false,
            willSpend: false,
            mutatedPaths: [],
          };
        } else {
          job.repairProposal = {
            version: 1,
            badShot: 1,
            resolution: "720p",
            options: [],
            executed: false,
            willRender: false,
            willSpend: false,
          };
        }
      });
      if (saved.ok) {
        process.stdout.write("persisted\n");
        return;
      }
      if (!saved.message.includes("retry shortly")) {
        throw new Error(saved.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt));
    }
    throw new Error("annotation gave up");
  }
  if (mode === "show-job") {
    const id = rest[0];
    if (!id) throw new Error("show-job needs a job id");
    await sweepOrphanTemps(JOBS_DIR);
    const job = await readPersistedJob(id);
    process.stdout.write(`${JSON.stringify({
      id: job?.id ?? null,
      state: job?.state ?? null,
      shots: job?.shots.length ?? null,
      pin: job?.settings?.pin ?? null,
      reviewVersion: job?.continuityReview?.version ?? null,
      findingCount: job?.continuityReview?.findings.length ?? null,
      spendSpent: job?.spendLedger?.spentUsd ?? null,
      spendPending: job?.spendLedger?.pendingUsd ?? null,
      spendThreshold: job?.spendLedger?.thresholdUsd ?? null,
      proposalVersion: job?.repairProposal?.version ?? null,
      proposalExecuted: job?.repairProposal?.executed ?? null,
      dependencyEdges: job?.dependencies?.edges.length ?? null,
      filmPath: job?.filmPath ?? null,
    })}\n`);
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

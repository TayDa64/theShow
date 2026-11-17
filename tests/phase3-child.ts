/**
 * One-shot worker for Phase 3 crash and hand-off tests.
 * Production never sets the append probe. This process does, when asked.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eventLogPath, setBeforeEventAppendProbe } from "../mcp/jobEvents.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { readProductionFeed } from "../mcp/productionFeed.ts";
import { thisOwner } from "../mcp/runtime.ts";
import { loadJobsFromDisk, persistJob, saveJobAnnotation, server, type SequenceJob } from "../mcp/server.ts";

function hang(): Promise<void> {
  return new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
}

function film(id: string): SequenceJob {
  return {
    id,
    startedAt: 1_700_000_000_000,
    state: "running",
    owner: thisOwner(),
    shotCount: 1,
    completed: 0,
    estimateUsd: 1,
    spentUsd: 0,
    shots: [],
  };
}

async function main(): Promise<void> {
  const [mode, id = "", entry = "stdio"] = process.argv.slice(2);
  if (entry === "http") await import("../mcp/http-server.ts");
  else await import("../mcp/server.ts");

  if (mode === "hold" || mode === "gap") {
    setBeforeEventAppendProbe(async () => {
      if (mode === "hold") {
        const logPath = eventLogPath(JOBS_DIR, id);
        if (!logPath) throw new Error("unsafe id");
        await mkdir(dirname(logPath), { recursive: true });
        await writeFile(logPath, "{\"partial\"", { flag: "a" });
      }
      process.stderr.write("event-append-hold\n");
      await hang();
    });
    await persistJob(film(id));
    return;
  }

  if (mode === "reap") {
    await loadJobsFromDisk();
    process.stdout.write("reaped\n");
    return;
  }

  if (mode === "feed") {
    const feed = await readProductionFeed({ jobsDir: JOBS_DIR, jobId: id || undefined, limit: 50 });
    process.stdout.write(JSON.stringify(feed));
    return;
  }

  if (mode === "render") {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "phase3-child", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [{ prompt: "A lantern on a table.", durationSeconds: 4, title: "Lantern" }],
        confirm: true,
        overrideValidation: true,
        assemble: false,
      },
    });
    const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    process.stdout.write(text);
    await client.close();
    return;
  }

  if (mode === "review" || mode === "repair") {
    const saved = await saveJobAnnotation(id, (job) => {
      if (mode === "review") {
        job.continuityReview = {
          version: 1,
          findings: [],
          executed: false,
          willRender: false,
          willSpend: false,
          mutatedPaths: [],
        };
        return;
      }
      job.repairProposal = {
        version: 1,
        badShot: 1,
        resolution: "720p",
        options: [{
          id: "retry-alone",
          costUsd: 1.12,
          fixes: [],
          leavesBroken: [],
          shotsToRender: [1],
          stillsToBuy: 0,
          requiresApproval: true,
        }],
        executed: false,
        willRender: false,
        willSpend: false,
      };
      job.spendLedger = {
        ...(job.spendLedger ?? { version: 1, spentUsd: job.spentUsd, pendingUsd: 0 }),
        thresholdUsd: 3,
      };
    });
    if (!saved.ok) throw new Error(saved.message);
    process.stdout.write("annotated\n");
    return;
  }

  throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

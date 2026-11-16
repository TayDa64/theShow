/**
 * One-shot worker for the multi-process lock and claim tests.
 * Invoked as `node --import tsx tests/mcp-multi-child.ts <mode> ...`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stat, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { saveCharacter } from "../mcp/characters.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { setBeforeRenameProbe, sweepOrphanTemps, thisOwner } from "../mcp/runtime.ts";
import { claimFilm, loadJobsFromDisk, persistJob, readPersistedJob, saveJobAnnotation, server, setBeforeClaimProbe } from "../mcp/server.ts";

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

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
  if (mode === "refuse-running") {
    const id = rest[0];
    if (!id) throw new Error("refuse-running needs a job id");
    const existing = await readPersistedJob(id);
    if (!existing) throw new Error("missing job");
    existing.state = "running";
    existing.owner = thisOwner();
    await persistJob(existing);
    const saved = await saveJobAnnotation(id, (job) => {
      job.continuityReview = {
        version: 1,
        findings: [],
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
      };
    });
    process.stdout.write(`${JSON.stringify(saved)}\n`);
    return;
  }
  if (mode === "annotate-once") {
    const id = rest[0];
    if (!id) throw new Error("annotate-once needs a job id");
    const saved = await saveJobAnnotation(id, (job) => {
      job.continuityReview = {
        version: 1,
        findings: [],
        executed: false,
        willRender: false,
        willSpend: false,
        mutatedPaths: [],
      };
    });
    process.stdout.write(`${JSON.stringify(saved)}\n`);
    return;
  }
  if (mode === "annotate-review" || mode === "annotate-repair" || mode === "annotate-batch") {
    const ids = mode === "annotate-batch" ? rest.slice(1) : rest;
    const kind = mode === "annotate-batch" ? rest[0] : mode;
    if (!kind || ids.length === 0 || ids.some((id) => !id)) throw new Error("annotate needs a job id");
    if (process.env.THESHOW_PAUSE_BEFORE_RENAME === "1") {
      setBeforeRenameProbe(async () => {
        process.stdout.write("paused-before-rename\n");
        await new Promise(() => undefined);
      });
    }
    if (process.env.THESHOW_CLAIM_GATE) {
      const gate = process.env.THESHOW_CLAIM_GATE;
      const seen = new Set<string>();
      setBeforeClaimProbe(async (jobId) => {
        if (seen.has(jobId)) return;
        seen.add(jobId);
        await writeFile(path.join(gate, `${jobId}.paused`), "1");
        await waitForFile(path.join(gate, `${jobId}.go`));
      });
    }
    for (const id of ids) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const saved = await saveJobAnnotation(id, (job) => {
        if (kind === "annotate-review" || kind === "review") {
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
        break;
      }
      if (!saved.message.includes("retry shortly")) {
        throw new Error(saved.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt));
    }
    const check = await readPersistedJob(id);
    const wrote = kind === "annotate-repair" || kind === "repair"
      ? check?.repairProposal?.version
      : check?.continuityReview?.version;
    if (!wrote) throw new Error(`annotation gave up for ${id}`);
    }
    process.stdout.write("persisted\n");
    return;
  }
  if (mode === "annotate-after-pause") {
    const [gate, kind, ...ids] = rest;
    if (!gate || !kind || ids.length === 0) throw new Error("annotate-after-pause needs a gate, kind, and ids");
    for (const id of ids) {
      await waitForFile(path.join(gate, `${id}.paused`));
      let wrote = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const saved = await saveJobAnnotation(id, (job) => {
          if (kind === "review") {
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
          wrote = true;
          break;
        }
        if (!saved.message.includes("retry shortly")) throw new Error(saved.message);
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt));
      }
      if (!wrote) throw new Error(`annotation gave up for ${id}`);
      await writeFile(path.join(gate, `${id}.go`), "1");
    }
    process.stdout.write("persisted\n");
    return;
  }
  if (mode === "hold-running") {
    const id = rest[0];
    if (!id) throw new Error("hold-running needs a job id");
    const existing = await readPersistedJob(id);
    if (!existing) throw new Error("missing job");
    existing.state = "running";
    existing.owner = thisOwner();
    await persistJob(existing);
    process.stdout.write("holding\n");
    await new Promise<void>((resolve) => {
      process.stdin.on("end", () => resolve());
      process.stdin.resume();
    });
    return;
  }
  if (mode === "call-tool") {
    const name = rest[0];
    const args = JSON.parse(rest[1] ?? "{}") as Record<string, unknown>;
    if (!name) throw new Error("call-tool needs a tool name");
    if (process.env.THESHOW_MOCK_PAID === "1") {
      process.env.XAI_API_KEY = "test-not-a-key";
      const body = JSON.stringify({
        request_id: "req-1",
        data: [{ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }],
      });
      globalThis.fetch = (async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "phase1-child", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    const content = result.content;
    const text = Array.isArray(content) && content[0] && "text" in content[0] ? String(content[0].text) : "";
    process.stdout.write(`${text}\n`);
    return;
  }
  if (mode === "load-jobs") {
    await loadJobsFromDisk();
    process.stdout.write("loaded\n");
    return;
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

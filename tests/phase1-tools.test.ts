/**
 * The free review tools and the additive cost fields on the existing spend tools.
 * Fetch is a spy. A refused quote must not call a generator.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { videoQuote } from "../mcp/costGate.ts";
import { JOBS_DIR, OUTPUT_DIR, resolveTools } from "../mcp/media.ts";
import { chargeForProviderResult, enqueueSpendNote, server } from "../mcp/server.ts";

const exec = promisify(execFile);

let client: Client;
const fetchCalls: string[] = [];

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("phase 1 tool test: no generator call is allowed");
  }) as typeof fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "phase1-tools", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

const shot = {
  prompt: "A man walks across the courtyard.",
  durationSeconds: 8,
  title: "Walk",
};

describe("phase 1 tools", () => {
  it("reviews a cut without rendering or spending", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "review_continuity",
      arguments: {
        shots: [
          {
            index: 1,
            worn: ["coat"],
            props: [{ id: "hanger", locationId: "room", placement: "on the wall" }],
            lastFramePath: "/no/such/1.png",
          },
          {
            index: 2,
            worn: ["shirt"],
            props: [{ id: "hanger", locationId: "room", placement: "on the wall" }],
            firstFramePath: "/no/such/2.png",
          },
        ],
        styleNotes: ["make it more epic"],
        narrativeSuggestions: ["add a twist"],
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.executed).toBe(false);
    expect(body.willRender).toBe(false);
    expect(body.willSpend).toBe(false);
    expect(body.persisted).toBe(false);
    const wardrobe = body.findings.find((finding: { topic: string }) => finding.topic === "wardrobe");
    expect(wardrobe.class).toBe("measured");
    expect(JSON.stringify(body.findings)).not.toContain("more epic");
    expect(JSON.stringify(body.findings)).not.toContain("twist");
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a video confirm that carries a board approval", async () => {
    fetchCalls.length = 0;
    const quote = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [shot],
        confirm: true,
        overrideValidation: true,
        approvedKind: "board",
        approvedUsd: quote.usd,
        approvedFingerprint: quote.fingerprint,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("refused");
    expect(body.willRender).toBe(false);
    expect(body.reason).toMatch(/board approval does not authorize a video/);
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a confirm when the resolution changes the quote", async () => {
    fetchCalls.length = 0;
    const quoted = videoQuote({ resolution: "720p", pin: "start", durations: [8] });
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [shot],
        resolution: "1080p",
        confirm: true,
        overrideValidation: true,
        approvedKind: "video",
        approvedUsd: quoted.usd,
        approvedFingerprint: quoted.fingerprint,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("refused");
    expect(body.willSpend).toBe(false);
    expect(body.reason).toMatch(/estimate changed/i);
    expect(fetchCalls).toEqual([]);
  });

  it("warns on the film budget and still does not spend without confirm", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [shot],
        confirm: false,
        overrideValidation: true,
        budgetUsd: 1,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("estimate-only");
    expect(body.willRender).toBe(false);
    expect(body.budgetWarning).toMatch(/does not authorize/);
    expect(body.costQuote.kind).toBe("video");
    expect(fetchCalls).toEqual([]);
  });

  it("does not let overrideValidation spend when confirm is false", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "extend_clip",
      arguments: {
        videoUrl: "https://example.test/clip.mp4",
        prompt: "The man keeps walking.",
        confirm: false,
        overrideValidation: true,
        budgetUsd: 0,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("estimate-only");
    expect(body.willRender).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it("proposes a repair and does not render it when confirm is set", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "propose_repair",
      arguments: {
        badShot: 2,
        resolution: "720p",
        confirm: true,
        overrideValidation: true,
        strategyId: "retry-alone",
        shots: [
          { index: 1, durationSeconds: 6, pin: "start", framePath: "/f/1-last.png" },
          {
            index: 2,
            durationSeconds: 8,
            pin: "both",
            firstFramePath: "/f/1-last.png",
            lastFramePath: "/f/board-2.png",
            boardStillPaths: ["/f/board-2.png"],
            extendedFrom: "/f/2-base.mp4",
          },
          { index: 3, durationSeconds: 6, pin: "both", firstFramePath: "/f/board-2.png" },
        ],
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.executed).toBe(false);
    expect(body.willRender).toBe(false);
    expect(body.willSpend).toBe(false);
    expect(body.advisory).toBe(true);
    expect(body.approval).toBeUndefined();
    const alone = body.options.find((option: { id: string; advisory?: boolean; costQuote?: { kind: string } }) => option.id === "retry-alone");
    const wider = body.options.find((option: { id: string; costQuote?: unknown }) => option.id === "retry-dependents");
    expect(alone.costUsd).toBe(1.12);
    expect(alone.advisory).toBe(true);
    expect(alone.costQuote).toBeUndefined();
    expect(wider.costQuote).toBeUndefined();
    expect(alone.leavesBroken.join(" ")).toMatch(/pinned boundary/);
    expect(fetchCalls).toEqual([]);
  });

  it("returns a costQuote from every paid estimate", async () => {
    fetchCalls.length = 0;
    const still = JSON.parse(toolText(await client.callTool({
      name: "generate_still",
      arguments: { prompt: "A quiet courtyard.", confirm: false },
    })));
    const clip = JSON.parse(toolText(await client.callTool({
      name: "generate_controlled_clip",
      arguments: { prompt: "A man walks across the courtyard.", confirm: false },
    })));
    const extension = JSON.parse(toolText(await client.callTool({
      name: "extend_clip",
      arguments: { videoUrl: "https://example.test/clip.mp4", prompt: "The man keeps walking.", confirm: false },
    })));
    const board = JSON.parse(toolText(await client.callTool({
      name: "board_film",
      arguments: { shots: [{ prompt: "A quiet courtyard." }], confirm: false },
    })));
    for (const body of [still, clip, extension, board]) {
      expect(body.action).toBe("estimate-only");
      expect(body.costQuote.fingerprint).toEqual(expect.any(String));
      expect(body.costQuote.usd).toEqual(expect.any(Number));
      expect(body.costQuote.kind).toEqual(expect.any(String));
      expect(body.unboundApproval).toBeUndefined();
    }
    expect(fetchCalls).toEqual([]);
  });

  it("returns a costQuote on a bare estimate", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "render_sequence",
      arguments: { shots: [shot], confirm: false },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("estimate-only");
    expect(body.costQuote.kind).toBe("video");
    expect(body.costQuote.usd).toBe(1.12);
    expect(body.costQuote.fingerprint).toEqual(expect.any(String));
    expect(body.unboundApproval).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a board confirm that names only a video kind, before any session check", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "board_film",
      arguments: {
        shots: [{ prompt: "A quiet courtyard." }],
        confirm: true,
        overrideValidation: true,
        approvedKind: "video",
        approvedUsd: 0.04,
        approvedFingerprint: "not-the-board",
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("refused");
    expect(body.willSpend).toBe(false);
    expect(body.reason).toMatch(/video approval does not authorize a board/);
    expect(JSON.stringify(body)).not.toMatch(/credential|session/i);
    expect(fetchCalls).toEqual([]);
  });

  it("refuses confirm when only approvedUsd is sent", async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [shot],
        confirm: true,
        overrideValidation: true,
        approvedUsd: 1.12,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("refused");
    expect(body.reason).toMatch(/approvedKind, approvedUsd, and approvedFingerprint/);
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a bound render quote when only the prompt changes", async () => {
    fetchCalls.length = 0;
    const first = JSON.parse(toolText(await client.callTool({
      name: "render_sequence",
      arguments: { shots: [shot], confirm: false },
    })));
    const second = JSON.parse(toolText(await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [{ ...shot, prompt: "A different man walks across the courtyard." }],
        confirm: true,
        overrideValidation: true,
        approvedKind: "video",
        approvedUsd: first.costQuote.usd,
        approvedFingerprint: first.costQuote.fingerprint,
      },
    })));
    expect(first.costQuote.usd).toBe(second.costQuote?.usd ?? first.costQuote.usd);
    expect(second.action).toBe("refused");
    expect(second.reason).toMatch(/estimate changed/i);
    expect(fetchCalls).toEqual([]);
  });

  it("names the quote on a bare confirm for render, retry, and extend", async () => {
    fetchCalls.length = 0;
    const id = "seq_phase1_unbound";
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1.12,
      spentUsd: 1.12,
      shots: [{
        index: 1,
        title: "Old",
        status: "completed",
        costUsd: 1.12,
        prompt: "A man walks across the courtyard.",
        durationSeconds: 8,
        localPath: "/keep/unbound.mp4",
      }],
      settings: {
        aspectRatio: "16:9",
        resolution: "720p",
        model: "grok-imagine-video-1.5",
        fadeDuration: 0,
        assemble: false,
        pin: "start",
      },
    }));
    const proposal = JSON.parse(toolText(await client.callTool({
      name: "propose_repair",
      arguments: { jobId: id, badShot: 1 },
    })));
    const retryEstimate = JSON.parse(toolText(await client.callTool({
      name: "retry_shot",
      arguments: { jobId: id, shotIndex: 1, confirm: false },
    })));
    const alone = proposal.options.find((option: { id: string; costQuote?: { fingerprint: string } }) => option.id === "retry-alone");
    expect(alone.costQuote.fingerprint).toBe(retryEstimate.costQuote.fingerprint);
    const rendered = JSON.parse(toolText(await client.callTool({
      name: "render_sequence",
      arguments: { shots: [shot], confirm: true, overrideValidation: true },
    })));
    const retried = JSON.parse(toolText(await client.callTool({
      name: "retry_shot",
      arguments: { jobId: id, shotIndex: 1, confirm: true, overrideValidation: true },
    })));
    const extended = JSON.parse(toolText(await client.callTool({
      name: "extend_clip",
      arguments: {
        videoUrl: "https://example.test/clip.mp4",
        prompt: "The man keeps walking.",
        confirm: true,
        overrideValidation: true,
      },
    })));
    for (const body of [rendered, retried, extended]) {
      expect(body.unboundApproval?.approvedKind).toEqual(expect.any(String));
      expect(body.unboundApproval?.approvedUsd).toEqual(expect.any(Number));
      expect(body.unboundApproval?.approvedFingerprint).toEqual(expect.any(String));
      expect(body.unboundApproval?.warning).toMatch(/not bound/);
    }
    expect(fetchCalls).toEqual([]);
  });

  it("warns from the film's recorded shot cost, not a supplied spent figure", async () => {
    fetchCalls.length = 0;
    const id = "seq_phase1_recorded_spend";
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1.12,
      spentUsd: 0,
      spendLedger: {
        version: 1,
        spentUsd: 1.2,
        pendingUsd: 0,
        thresholdUsd: 1.15,
        entries: [
          { kind: "video", usd: 1.12 },
          { kind: "still", usd: 0.08 },
        ],
      },
      shots: [{ index: 1, title: "Old", status: "completed", costUsd: 1.12, prompt: "A man walks across the courtyard.", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: true, pin: "start" },
    }));
    const result = await client.callTool({
      name: "render_sequence",
      arguments: {
        shots: [shot],
        confirm: false,
        resumeFromJobId: id,
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe("estimate-only");
    expect(body.willRender).toBe(false);
    expect(body.budgetWarning).toMatch(/1\.20/);
    expect(body.budgetWarning).not.toMatch(/Spent \$1\.12 /);
    expect(body.budgetWarning).toMatch(/does not authorize/);
    expect(body.costQuote.kind).toBe("video");
    expect(fetchCalls).toEqual([]);
  });

  it("names the quote when a bare board confirm reaches the session check", async () => {
    fetchCalls.length = 0;
    const body = JSON.parse(toolText(await client.callTool({
      name: "board_film",
      arguments: {
        shots: [{ prompt: "A quiet courtyard." }],
        confirm: true,
        overrideValidation: true,
      },
    })));
    expect(body.costQuote.kind).toBe("board");
    expect(body.costQuote.usd).toEqual(expect.any(Number));
    expect(body.unboundApproval?.warning).toMatch(/not bound/);
    expect(fetchCalls).toEqual([]);
  });

  it("names the quote on a render and a retry that actually start", async () => {
    process.env.THESHOW_STUB_VIDEO = "1";
    try {
      const rendered = JSON.parse(toolText(await client.callTool({
        name: "render_sequence",
        arguments: { shots: [shot], confirm: true, overrideValidation: true, assemble: false },
      })));
      expect(rendered.jobId).toEqual(expect.any(String));
      expect(rendered.unboundApproval?.approvedKind).toBe("video");
      expect(rendered.unboundApproval?.warning).toMatch(/not bound/);
      const id = "seq_phase1_retry_success";
      await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
        id,
        startedAt: 1,
        state: "completed",
        shotCount: 1,
        completed: 1,
        estimateUsd: 1.12,
        spentUsd: 1.12,
        shots: [{
          index: 1,
          title: "Old",
          status: "completed",
          costUsd: 1.12,
          prompt: "A man walks across the courtyard.",
          durationSeconds: 8,
          localPath: "/keep/retry-success.mp4",
        }],
        settings: {
          aspectRatio: "16:9",
          resolution: "720p",
          model: "grok-imagine-video-1.5",
          fadeDuration: 0,
          assemble: false,
          pin: "start",
        },
      }));
      const retried = JSON.parse(toolText(await client.callTool({
        name: "retry_shot",
        arguments: { jobId: id, shotIndex: 1, confirm: true, overrideValidation: true },
      })));
      expect(retried.jobId).toEqual(expect.any(String));
      expect(retried.unboundApproval?.approvedKind).toBe("retry");
      expect(retried.unboundApproval?.warning).toMatch(/not bound/);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  }, 30_000);

  it("keeps a resumed film's ledger on the new job", async () => {
    process.env.THESHOW_STUB_VIDEO = "1";
    try {
      const id = "seq_phase1_resume_ledger";
      await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
        id,
        startedAt: 1,
        state: "completed",
        shotCount: 1,
        completed: 1,
        estimateUsd: 1.12,
        spentUsd: 1.12,
        spendLedger: {
          version: 1,
          spentUsd: 1.2,
          pendingUsd: 0,
          entries: [
            { kind: "video", usd: 1.12 },
            { kind: "still", usd: 0.08 },
          ],
        },
        shots: [{
          index: 1,
          title: "Old",
          status: "completed",
          costUsd: 1.12,
          prompt: "A lantern.",
          durationSeconds: 8,
          localPath: "/keep/resume.mp4",
        }],
        settings: {
          aspectRatio: "16:9",
          resolution: "720p",
          model: "grok-imagine-video-1.5",
          fadeDuration: 0,
          assemble: false,
          pin: "start",
        },
      }));
      const resumed = JSON.parse(toolText(await client.callTool({
        name: "render_sequence",
        arguments: {
          shots: [shot],
          confirm: true,
          overrideValidation: true,
          assemble: false,
          resumeFromJobId: id,
        },
      })));
      expect(resumed.jobId).toEqual(expect.any(String));
      let ledger: { spentUsd?: number; entries?: unknown[] } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const raw = await readFile(`${JOBS_DIR}/${resumed.jobId}.json`, "utf8");
        ledger = JSON.parse(raw).spendLedger;
        if (ledger) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(ledger?.spentUsd).toBe(1.2);
      expect(ledger?.entries).toHaveLength(2);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  });

  it("keeps a replaced shot's cost when a pre-ledger film is retried", async () => {
    process.env.THESHOW_STUB_VIDEO = "1";
    try {
      const id = "seq_phase1_legacy_ledger";
      const shots = [0.28, 0.28, 0.28, 0.28].map((costUsd, index) => ({
        index: index + 1,
        title: `Shot ${index + 1}`,
        status: "completed",
        costUsd,
        prompt: "A lantern.",
        durationSeconds: 2,
        localPath: `/keep/legacy-${index + 1}.mp4`,
      }));
      await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
        id,
        startedAt: 1,
        state: "completed",
        shotCount: 4,
        completed: 4,
        estimateUsd: 1.12,
        spentUsd: 1.12,
        shots,
        settings: {
          aspectRatio: "16:9",
          resolution: "720p",
          model: "grok-imagine-video-1.5",
          fadeDuration: 0,
          assemble: false,
          pin: "start",
        },
      }));
      const retried = JSON.parse(toolText(await client.callTool({
        name: "retry_shot",
        arguments: { jobId: id, shotIndex: 1, confirm: true, overrideValidation: true },
      })));
      const saved = JSON.parse(await readFile(`${JOBS_DIR}/${retried.jobId}.json`, "utf8")) as {
        spendLedger?: { spentUsd: number; entries: Array<{ derived?: boolean }> };
      };
      expect(saved.spendLedger?.spentUsd).toBe(1.12);
      expect(saved.spendLedger?.entries.every((entry) => entry.derived)).toBe(true);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  }, 30_000);

  it("names the quote and records the estimate when an extension is submitted, times out, or returns no usage", async () => {
    const previous = globalThis.fetch;
    const previousKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-not-a-key";
    const id = "seq_phase1_extend_spend";
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1.12,
      spentUsd: 1.12,
      shots: [{ index: 1, title: "Old", status: "completed", costUsd: 1.12, prompt: "A lantern.", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    try {
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/videos/extensions")) return respond({ request_id: "req-extend" });
        return respond({ status: "completed", video: { url: "https://example.test/out.mp4", duration: 6 } });
      }) as typeof fetch;
      const submitted = JSON.parse(toolText(await client.callTool({
        name: "extend_clip",
        arguments: {
          videoUrl: "https://example.test/clip.mp4",
          prompt: "The man keeps walking.",
          confirm: true,
          overrideValidation: true,
          waitForCompletion: false,
          jobId: id,
        },
      })));
      expect(submitted.status).toBe("submitted");
      expect(submitted.unboundApproval?.warning).toMatch(/not bound/);
      expect(submitted.costEstimated).toBe(true);
      const completed = JSON.parse(toolText(await client.callTool({
        name: "extend_clip",
        arguments: {
          videoUrl: "https://example.test/clip.mp4",
          prompt: "The man keeps walking.",
          confirm: true,
          overrideValidation: true,
          waitForCompletion: true,
          timeoutSeconds: 10,
          jobId: id,
        },
      })));
      expect(completed.status).toBe("completed");
      expect(completed.unboundApproval?.warning).toMatch(/not bound/);
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/videos/extensions")) return respond({ request_id: "req-timeout" });
        return respond({ status: "pending" });
      }) as typeof fetch;
      const timedOut = JSON.parse(toolText(await client.callTool({
        name: "extend_clip",
        arguments: {
          videoUrl: "https://example.test/clip.mp4",
          prompt: "The man keeps walking.",
          confirm: true,
          overrideValidation: true,
          waitForCompletion: true,
          timeoutSeconds: 10,
          jobId: id,
        },
      })));
      expect(timedOut.status).toBe("timeout");
      expect(timedOut.unboundApproval?.warning).toMatch(/not bound/);
      expect(timedOut.costEstimated).toBe(true);
      const saved = JSON.parse(await readFile(`${JOBS_DIR}/${id}.json`, "utf8")) as {
        spendLedger?: { entries?: Array<{ kind: string; estimated?: boolean }> };
      };
      const extensions = saved.spendLedger?.entries?.filter((entry) => entry.kind === "extend") ?? [];
      expect(extensions.length).toBeGreaterThanOrEqual(3);
      expect(extensions.every((entry) => entry.estimated)).toBe(true);
    } finally {
      globalThis.fetch = previous;
      if (previousKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousKey;
    }
  }, 30_000);

  it("cites the source clip instead of a review frame that is deleted, and does not write that frame into media", async () => {
    const clip = `${OUTPUT_DIR}/phase1-review-source.mp4`;
    const frame = `${OUTPUT_DIR}/phase1-review-last.png`;
    await mkdir(OUTPUT_DIR, { recursive: true });
    const { ffmpeg } = await resolveTools();
    await exec(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2", "-frames:v", "1", clip]);
    await exec(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=white:s=16x16:d=0.1", "-frames:v", "1", frame]);
    const before = new Set(await readdir(OUTPUT_DIR));
    const id = "seq_phase1_review_frames";
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 2,
      completed: 2,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [
        { index: 1, title: "A", status: "completed", localPath: clip, framePath: frame, durationSeconds: 2, prompt: "A lantern." },
        { index: 2, title: "B", status: "completed", localPath: clip, durationSeconds: 2, prompt: "A lantern." },
      ],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    const body = JSON.parse(toolText(await client.callTool({
      name: "review_continuity",
      arguments: { jobId: id },
    })));
    const cited = JSON.stringify(body.findings);
    expect(cited).not.toContain(".review-frames-");
    expect(cited).toContain(clip);
    const saved = JSON.parse(await readFile(`${JOBS_DIR}/${id}.json`, "utf8"));
    expect(JSON.stringify(saved.continuityReview)).not.toContain(".review-frames-");
    const after = await readdir(OUTPUT_DIR);
    expect(after.filter((name) => name.startsWith("frame-first-") && !before.has(name))).toEqual([]);
    const jobs = await readdir(JOBS_DIR);
    expect(jobs.filter((name) => name.startsWith(".review-frames-"))).toEqual([]);
  });

  it("records the quoted shot price when a completed render reports no usage", async () => {
    process.env.THESHOW_STUB_VIDEO = "completed";
    try {
      const rendered = JSON.parse(toolText(await client.callTool({
        name: "render_sequence",
        arguments: { shots: [shot], confirm: true, overrideValidation: true, assemble: false },
      })));
      let ledger: { entries?: Array<{ kind: string; usd: number; estimated?: boolean }> } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const raw = await readFile(`${JOBS_DIR}/${rendered.jobId}.json`, "utf8");
        ledger = JSON.parse(raw).spendLedger;
        if (ledger?.entries?.some((entry) => entry.estimated)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const estimated = ledger?.entries?.find((entry) => entry.estimated);
      expect(estimated?.kind).toBe("video");
      expect(estimated?.usd).toBe(1.12);
    } finally {
      delete process.env.THESHOW_STUB_VIDEO;
    }
  });

  it("records a clip quote when the provider accepts the job and reports no cost", async () => {
    const previous = globalThis.fetch;
    const previousKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-not-a-key";
    const id = "seq_phase1_clip_quote";
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 0,
      completed: 0,
      estimateUsd: 0,
      spentUsd: 0,
      shots: [],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ request_id: "req-clip" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const body = JSON.parse(toolText(await client.callTool({
        name: "generate_controlled_clip",
        arguments: {
          prompt: "A lantern.",
          durationSeconds: 1,
          confirm: true,
          overrideValidation: true,
          waitForCompletion: false,
          jobId: id,
        },
      })));
      expect(body.status).toBe("submitted");
      const saved = JSON.parse(await readFile(`${JOBS_DIR}/${id}.json`, "utf8")) as {
        spendLedger?: { spentUsd: number; entries: Array<{ usd: number; estimated?: boolean }> };
      };
      expect(saved.spendLedger?.spentUsd).toBe(0.14);
      expect(saved.spendLedger?.entries).toEqual([{ kind: "video", usd: 0.14, estimated: true }]);
    } finally {
      globalThis.fetch = previous;
      if (previousKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousKey;
    }
  });

  it("records a refused clip or still as zero with the reason", async () => {
    const previous = globalThis.fetch;
    const previousKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-not-a-key";
    const id = "seq_phase1_unbilled";
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: 1,
      state: "completed",
      shotCount: 0,
      completed: 0,
      estimateUsd: 0,
      spentUsd: 0,
      shots: [],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    try {
      globalThis.fetch = (async () => new Response("no", { status: 400 })) as typeof fetch;
      await client.callTool({
        name: "generate_controlled_clip",
        arguments: { prompt: "A lantern.", durationSeconds: 1, confirm: true, overrideValidation: true, jobId: id },
      });
      await client.callTool({
        name: "generate_still",
        arguments: { prompt: "A lantern.", confirm: true, overrideValidation: true, jobId: id },
      });
      const saved = JSON.parse(await readFile(`${JOBS_DIR}/${id}.json`, "utf8")) as {
        spendLedger?: { spentUsd: number; entries: Array<{ kind: string; usd: number; estimated?: boolean; reason?: string }> };
      };
      expect(saved.spendLedger?.spentUsd).toBe(0);
      expect(saved.spendLedger?.entries?.map((entry) => entry.kind).sort()).toEqual(["still", "video"]);
      expect(saved.spendLedger?.entries?.every((entry) => entry.usd === 0 && entry.reason && !entry.estimated)).toBe(true);
    } finally {
      globalThis.fetch = previous;
      if (previousKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousKey;
    }
  });

  it("marks an unknown bill as uncertain and leaves an unbilled refusal at zero", () => {
    expect(chargeForProviderResult({ status: "timeout" }, 0.14)).toMatchObject({
      record: true,
      usd: 0.14,
      estimated: true,
      uncertain: true,
    });
    expect(chargeForProviderResult({ code: "submit-failed", status: "failed", error: "rejected by the proxy" }, 0.14)).toMatchObject({
      record: true,
      usd: 0,
      reason: "rejected by the proxy",
    });
  });

  it("shows queued spend before a claim, and warns from that total", async () => {
    const id = `seq_phase1_queued_${randomUUID()}`;
    await writeFile(`${JOBS_DIR}/${id}.json`, JSON.stringify({
      id,
      startedAt: Date.now(),
      state: "completed",
      shotCount: 1,
      completed: 1,
      estimateUsd: 1.12,
      spentUsd: 1.12,
      filmPath: "/keep/queued.mp4",
      spendLedger: { version: 1, spentUsd: 1.12, pendingUsd: 0, thresholdUsd: 1.2, entries: [{ kind: "video", usd: 1.12 }] },
      shots: [{ index: 1, title: "Old", status: "completed", costUsd: 1.12, prompt: "A lantern.", durationSeconds: 8 }],
      settings: { aspectRatio: "16:9", resolution: "720p", model: "grok-imagine-video-1.5", fadeDuration: 0, assemble: false, pin: "start" },
    }));
    await enqueueSpendNote(id, { op: "spend", kind: "video", usd: 0.56, estimated: true });
    const checked = JSON.parse(toolText(await client.callTool({
      name: "check_sequence",
      arguments: { jobId: id },
    })));
    expect(checked.pendingSpendUsd).toBe(0.56);
    expect(checked.spendLedger.spentUsd).toBe(1.12);
    const listed = JSON.parse(toolText(await client.callTool({
      name: "list_films",
      arguments: { includeUnfinished: true, limit: 50 },
    })));
    const film = listed.films.find((entry: { jobId: string }) => entry.jobId === id);
    expect(film.pendingSpendUsd).toBe(0.56);
    expect(film.spentUsd).toBe(1.12);
    const estimate = JSON.parse(toolText(await client.callTool({
      name: "generate_still",
      arguments: { prompt: "A lantern.", confirm: false, jobId: id },
    })));
    expect(estimate.budgetWarning).toMatch(/1\.68/);
    const raw = JSON.parse(await readFile(`${JOBS_DIR}/${id}.json`, "utf8")) as { spendLedger?: { spentUsd?: number; appliedNoteIds?: string[] } };
    expect(raw.spendLedger?.spentUsd).toBe(1.12);
    expect(raw.spendLedger?.appliedNoteIds).toBeUndefined();
  });
});

/**
 * The free review tools and the additive cost fields on the existing spend tools.
 * Fetch is a spy. A refused quote must not call a generator.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { videoQuote } from "../mcp/costGate.ts";
import { JOBS_DIR } from "../mcp/media.ts";
import { server } from "../mcp/server.ts";

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
});

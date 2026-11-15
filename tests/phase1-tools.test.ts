/**
 * The free review tools and the additive cost fields on the existing spend tools.
 * Fetch is a spy. A refused quote must not call a generator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { videoQuote } from "../mcp/costGate.ts";
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
    expect(body.approval.decision).toBe("estimate");
    expect(body.approval.executed).toBe(false);
    const alone = body.options.find((option: { id: string }) => option.id === "retry-alone");
    expect(alone.costUsd).toBe(1.12);
    expect(alone.leavesBroken.join(" ")).toMatch(/hard cut/);
    expect(fetchCalls).toEqual([]);
  });
});

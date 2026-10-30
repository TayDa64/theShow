#!/usr/bin/env tsx
/**
 * theShow MCP Server (enhanced for testing)
 * - Stubs for most tools
 * - generate_controlled_clip calls real Grok Imagine Video when XAI_API_KEY is set
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "theshow",
  version: "0.1.0",
});

const CharacterSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  referenceImageUrls: z.array(z.string().url()).optional(),
});

server.registerTool(
  "create_character",
  {
    description: "Create or update a character with optional reference images for continuity.",
    inputSchema: CharacterSchema,
  },
  async (args) => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: `char_${Date.now()}`,
          ...args,
          message: "Character created (stub). Wire to real theShow store."
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "plan_storyboard",
  {
    description: "Plan multi-shot storyboard for a scene.",
    inputSchema: z.object({
      sceneDescription: z.string(),
      characters: z.array(z.string()),
      targetDurationSeconds: z.number().optional(),
      shotCount: z.number().optional(),
    }),
  },
  async (args) => {
    const shots = [
      { title: "Establishing", action: "Wide shot of the location", durationSeconds: 8, continuityNotes: "Set the atmosphere" },
      { title: "Character Intro", action: "Medium shot of main character", durationSeconds: 8, continuityNotes: "Match previous lighting" },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify({ shots, scene: args.sceneDescription }, null, 2) }]
    };
  }
);

async function callGrokImagineVideo(args: {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  model?: string;
  referenceImageUrls?: string[];
  firstFrameUrl?: string;
}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { error: "XAI_API_KEY not set", fallback: "stub" };
  }

  const body: Record<string, unknown> = {
    model: args.model || "grok-imagine-video-1.5",
    prompt: args.prompt,
    duration: args.durationSeconds || 8,
    aspect_ratio: args.aspectRatio || "16:9",
  };

  if (args.firstFrameUrl) {
    body.image = { url: args.firstFrameUrl };
  }
  if (args.referenceImageUrls && args.referenceImageUrls.length > 0) {
    body.reference_images = args.referenceImageUrls.map(url => ({ url }));
  }

  const res = await fetch("https://api.x.ai/v1/videos/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `API error ${res.status}`, detail: text };
  }

  const data = await res.json();
  return { requestId: data.request_id, status: "submitted", raw: data };
}

server.registerTool(
  "generate_controlled_clip",
  {
    description: "Generate a single video clip with reference images and optional first-frame continuity. Calls real Grok Imagine Video when XAI_API_KEY is set.",
    inputSchema: z.object({
      prompt: z.string(),
      referenceImageUrls: z.array(z.string().url()).optional(),
      firstFrameUrl: z.string().url().optional(),
      durationSeconds: z.number().min(1).max(15).default(8),
      aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      model: z.string().default("grok-imagine-video-1.5"),
    }),
  },
  async (args) => {
    const result = await callGrokImagineVideo(args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...result,
          message: result.requestId
            ? "Real generation submitted to Grok Imagine Video. Poll with the requestId or check console.x.ai."
            : "Stub response (set XAI_API_KEY for real generation).",
          args,
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "extend_clip",
  {
    description: "Extend an existing clip from its last frame.",
    inputSchema: z.object({
      videoUrl: z.string().url(),
      prompt: z.string(),
      durationSeconds: z.number().min(2).max(10).default(6),
    }),
  },
  async (args) => {
    return {
      content: [{ type: "text", text: JSON.stringify({ requestId: `ext_${Date.now()}`, status: "stub", ...args }) }]
    };
  }
);

server.registerTool(
  "extract_last_frame",
  {
    description: "Extract the last frame of a video as a PNG for use as first_frame on the next shot.",
    inputSchema: z.object({
      videoUrl: z.string().url(),
    }),
  },
  async (args) => {
    return {
      content: [{ type: "text", text: JSON.stringify({ frameUrl: "https://example.com/frame.png", status: "stub", ...args }) }]
    };
  }
);

server.registerTool(
  "assemble_film",
  {
    description: "Assemble ordered clips into a single film with cross-fades.",
    inputSchema: z.object({
      clips: z.array(z.object({
        url: z.string().url(),
        title: z.string().optional(),
        trimStart: z.number().optional(),
        trimEnd: z.number().optional(),
      })),
      fadeDuration: z.number().default(0.5),
    }),
  },
  async (args) => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          filmId: `film_${Date.now()}`,
          downloadUrl: "https://example.com/film.mp4",
          status: "stub",
          message: "Assembly stub. Wire to existing /api/assemble-film.",
          clipCount: args.clips.length,
        }, null, 2)
      }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("theShow MCP server running on stdio (enhanced test build)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

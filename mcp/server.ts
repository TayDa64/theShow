#!/usr/bin/env tsx
/**
 * theShow MCP Server
 * Thin wrapper exposing controlled video generation tools.
 * In production this would call the existing Express routes or extract pure functions from server.ts.
 * For Grok Build / Remote MCP use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "theshow",
  version: "0.1.0",
});

// --- Tool Schemas (Zod) ---

const CharacterSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  description: z.string().optional(),
  referenceImageUrls: z.array(z.string().url()).optional(),
});

const ShotSchema = z.object({
  title: z.string(),
  action: z.string(),
  dialogueExcerpt: z.string().optional(),
  durationSeconds: z.number().min(4).max(15).default(8),
  continuityNotes: z.string().optional(),
});

server.registerTool(
  "create_character",
  {
    description: "Create or update a character with optional reference images for continuity.",
    inputSchema: CharacterSchema,
  },
  async (args) => {
    // TODO: call existing /api/generate-character + store refs
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
    description: "Plan multi-shot storyboard for a scene using Gemini cinematographer logic.",
    inputSchema: z.object({
      sceneDescription: z.string(),
      characters: z.array(z.string()),
      targetDurationSeconds: z.number().optional(),
      shotCount: z.number().optional(),
    }),
  },
  async (args) => {
    // TODO: call /api/generate-storyboard
    const shots: z.infer<typeof ShotSchema>[] = [
      { title: "Establishing", action: "Wide shot of the location", durationSeconds: 8 },
      { title: "Character Intro", action: "Medium shot of main character", durationSeconds: 8 },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify({ shots }, null, 2) }]
    };
  }
);

server.registerTool(
  "generate_controlled_clip",
  {
    description: "Generate a single video clip with reference images and optional first-frame continuity. Supports Grok Imagine Video 1.5 (preferred) or Veo.",
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
    // TODO: route to Grok Imagine API or existing /api/generate-shot-video
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          requestId: `req_${Date.now()}`,
          status: "submitted",
          message: "Clip generation started (stub). Implement real call to xAI video API or theShow Veo path.",
          ...args
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "extend_clip",
  {
    description: "Extend an existing clip from its last frame (video_to_extend).",
    inputSchema: z.object({
      videoUrl: z.string().url(),
      prompt: z.string(),
      durationSeconds: z.number().min(2).max(10).default(6),
    }),
  },
  async (args) => {
    return {
      content: [{ type: "text", text: JSON.stringify({ requestId: `ext_${Date.now()}`, ...args }) }]
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
      content: [{ type: "text", text: JSON.stringify({ frameUrl: "https://example.com/frame.png", ...args }) }]
    };
  }
);

server.registerTool(
  "assemble_film",
  {
    description: "Assemble ordered clips into a single film with cross-fades using FFmpeg.",
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
          message: "Assembly stub. Wire to existing /api/assemble-film."
        }, null, 2)
      }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("theShow MCP server running on stdio");
}

main().catch(console.error);
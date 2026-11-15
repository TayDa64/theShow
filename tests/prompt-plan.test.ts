/**
 * plan_storyboard keeps today's JSON unless promptStyle is sections-v2.
 * The server is driven in memory. Nothing is rendered.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from '../mcp/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/b2.proposed-entry.json'), 'utf8'),
) as {
  prompt: string;
  framing: string;
  camera: string;
  durationSeconds: number;
  steps: string[];
  line: { text: string; delivery: string; voiceTag: string };
  contact: string;
  avoid: string[];
  audio: string;
  faceAnchor: string;
  start: unknown;
  end: unknown;
  action: string;
  title: string;
};

let client: Client;

function toolText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return '';
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? '';
}

beforeAll(async () => {
  process.env.THESHOW_CHARACTERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-sections-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'theshow-sections', version: '0.0.0' });
  await client.connect(clientTransport);
  await client.callTool({
    name: 'create_character',
    arguments: {
      name: 'Tay',
      appearance: 'Bald head, full black beard.',
      wardrobe: {
        layers: [
          { id: 'coat', item: 'tan sherpa coat', order: 5, inReference: 'visible', closure: 'open' },
          { id: 'blazer', item: 'navy blazer', order: 4, inReference: 'visible', closure: 'open' },
          { id: 'shirt', item: 'blue and white striped shirt, open collar, no tie', order: 3, inReference: 'visible' },
          { id: 'trousers', item: 'dark trousers', order: 2, inReference: 'visible' },
          { id: 'dress-shoes', item: 'black slip-on dress shoes', order: 1, inReference: 'visible', type: 'footwear', closure: 'slip-on' },
          { id: 'cardigan', item: 'beige cardigan', order: 6, inReference: 'visible' },
        ],
        startState: { worn: ['shirt', 'trousers', 'dress-shoes', 'blazer', 'coat'] },
      },
    },
  });
});

afterAll(async () => {
  await client.close();
});

describe('plan_storyboard prompt style', () => {
  it('leaves the default plan on the old ladder', async () => {
    const result = await client.callTool({
      name: 'plan_storyboard',
      arguments: {
        sceneDescription: 'A hall.',
        characters: [],
        targetDurationSeconds: 12,
        beats: [
          { title: 'b1', action: 'He opens the door.' },
          { title: 'b2', action: 'He takes off the coat.' },
        ],
      },
    });
    const body = JSON.parse(toolText(result)) as {
      shots: Array<Record<string, unknown>>;
    };
    expect(body.shots[1].shotType).toBe('medium');
    expect(body.shots[0].durationSeconds).toBe(6);
    expect(body.shots[1].durationSeconds).toBe(6);
    expect(body.shots[0].prompt).toBeUndefined();
    expect(body.shots[1].prompt).toBeUndefined();
    expect(String(body.shots[1].action).startsWith('He takes off the coat.')).toBe(true);
    expect(String(body.shots[1].action)).not.toContain('START:');
  });

  it('renders the b2 sections when asked, and does not append the ledger paragraph', async () => {
    const result = await client.callTool({
      name: 'plan_storyboard',
      arguments: {
        sceneDescription: 'Halfway Station hall.',
        characters: ['Tay'],
        promptStyle: 'sections-v2',
        voiceId: 'rex',
        targetDurationSeconds: 12,
        fixedSet: "door, amber lamp, drawing, rail with three wooden hangers, moon window, and one solid one-piece oak bench from below the drawing to the frame's right edge, never moved or resized",
        marks: { A: 'He is under the amber lamp, just past the door frame, facing the camera.' },
        beats: [{
          title: entry.title,
          action: entry.action,
          framing: entry.framing,
          camera: entry.camera,
          durationSeconds: entry.durationSeconds,
          faceAnchor: entry.faceAnchor,
          steps: entry.steps,
          line: entry.line,
          contact: entry.contact,
          avoid: entry.avoid,
          audio: entry.audio,
          start: entry.start,
          end: entry.end,
          wardrobeEvents: [{ action: 'remove', layer: 'coat', character: 'Tay' }],
        }],
      },
    });
    const body = JSON.parse(toolText(result)) as {
      shots: Array<{ prompt?: string; action: string; shotType: string; durationSeconds: number }>;
    };
    expect(body.shots[0].shotType).toBe('wide');
    expect(body.shots[0].durationSeconds).toBe(4);
    expect(body.shots[0].prompt).toBe(entry.prompt);
    expect(body.shots[0].action).not.toMatch(/unbuttons/i);
    expect(body.shots[0].action).toBe(entry.action);
    const continuity = (JSON.parse(toolText(result)) as { continuity: { promptStyle?: string; voiceId?: string } }).continuity;
    expect(continuity.promptStyle).toBe('sections-v2');
    expect(continuity.voiceId).toBe('rex');
  });

  it('keeps a face anchor on a legacy beat', async () => {
    const result = await client.callTool({
      name: 'plan_storyboard',
      arguments: {
        sceneDescription: 'A hall.',
        characters: [],
        beats: [{ title: 'feet', action: 'The camera looks at his shoes.', faceAnchor: 'off' }],
      },
    });
    const body = JSON.parse(toolText(result)) as { shots: Array<{ faceAnchor?: string }> };
    expect(body.shots[0].faceAnchor).toBe('off');
  });

  it('keeps the wardrobe paragraph when sections-v2 has no beats', async () => {
    const result = await client.callTool({
      name: 'plan_storyboard',
      arguments: {
        sceneDescription: 'A hall.',
        characters: ['Tay'],
        promptStyle: 'sections-v2',
        shotCount: 1,
      },
    });
    const body = JSON.parse(toolText(result)) as { shots: Array<{ action: string; prompt?: string }> };
    expect(body.shots[0].action).toContain('tan sherpa coat');
    expect(body.shots[0].prompt ?? '').not.toContain('START:');
  });
});

/**
 * Opt-in section prompts, and the planner fixes that must not move
 * existing fixtures: an unset promptStyle stays on today's ladder.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveContracts, expandWardrobeEventToSteps } from '../mcp/contracts.ts';
import { gateRenderSequence } from '../mcp/contracts.ts';
import type { ContinuityPlan, WardrobeLayer } from '../mcp/continuity.ts';
import { resolveBeatDuration, resolveBeatShotType } from '../mcp/beats.ts';
import {
  FACE_ANCHOR_SENTENCE,
  renderSectionsV2,
  shouldAnchorFace,
  type SectionBeat,
} from '../mcp/promptSections.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/b2.proposed-entry.json'), 'utf8'),
) as SectionBeat & { prompt: string; faceAnchor?: 'auto' | 'off' };
const b2File = fs.readFileSync(path.join(here, 'fixtures/b2.txt'));

const tayLayers: WardrobeLayer[] = [
  { id: 'coat', item: 'tan sherpa coat', order: 5, inReference: 'visible', closure: 'open' },
  { id: 'blazer', item: 'navy blazer', order: 4, inReference: 'visible', closure: 'open' },
  { id: 'shirt', item: 'blue and white striped shirt, open collar, no tie', order: 3, inReference: 'visible' },
  { id: 'trousers', item: 'dark trousers', order: 2, inReference: 'visible' },
  { id: 'dress-shoes', item: 'black slip-on dress shoes', order: 1, inReference: 'visible', type: 'footwear', closure: 'slip-on' },
  { id: 'cardigan', item: 'beige cardigan', order: 6, inReference: 'visible' },
];

const b2Context = {
  layers: tayLayers,
  marks: {
    A: 'He is under the amber lamp, just past the door frame, facing the camera.',
  },
  fixedSet:
    "door, amber lamp, drawing, rail with three wooden hangers, moon window, and one solid one-piece oak bench from below the drawing to the frame's right edge, never moved or resized",
};

describe('sections-v2', () => {
  it('renders b2 to the traced prompt, then the face sentence, byte for byte', () => {
    const prompt = renderSectionsV2(entry, b2Context);
    expect(prompt).toBe(entry.prompt);
    const http = shouldAnchorFace(prompt, { faceAnchor: entry.faceAnchor })
      ? `${prompt} ${FACE_ANCHOR_SENTENCE}`
      : prompt;
    expect(Buffer.from(`${http}\n`, 'utf8')).toEqual(b2File);
  });

  it('writes at most one negative', () => {
    const prompt = renderSectionsV2(
      { ...entry, avoid: ['a second coat', 'a second blazer'] },
      b2Context,
    );
    expect(prompt).toContain('AVOID: a second coat.');
    expect(prompt).not.toContain('a second blazer');
  });

  it('puts <AUDIO_0> in the line only when a voice is set', () => {
    const voiced = renderSectionsV2(entry, { ...b2Context, voiceId: 'rex' });
    expect(voiced).toContain('in the voice from <AUDIO_0>');
    const silent = renderSectionsV2(
      { ...entry, line: { text: 'Halfway to the moon and back.', delivery: 'sung' } },
      b2Context,
    );
    expect(silent).not.toContain('<AUDIO_0>');
  });
});

describe('planner fixes leave the default ladder alone', () => {
  it('keeps later beats medium and an even split when no new fields are set', () => {
    expect(resolveBeatShotType({}, 0)).toBe('wide');
    expect(resolveBeatShotType({}, 1)).toBe('medium');
    expect(resolveBeatDuration({}, 6)).toBe(6);
  });

  it('honours a framing, a per-beat duration, and a sung line', () => {
    expect(resolveBeatShotType({ framing: 'wide' }, 1)).toBe('wide');
    expect(resolveBeatDuration({ durationSeconds: 4 }, 6)).toBe(4);
    expect(resolveBeatDuration(
      { line: { text: 'Halfway to the moon and back.', delivery: 'sung' } },
      6,
    )).toBe(4);
  });

  it('does not say unbuttons when the stored coat is already open', () => {
    const plan: ContinuityPlan = {
      characters: [{
        name: 'Tay',
        wardrobe: { layers: tayLayers, startState: { worn: ['coat'] } },
      }],
      shotCount: 1,
      wardrobeEvents: [{ shot: 1, action: 'remove', layer: 'coat', character: 'Tay' }],
    };
    expect(expandWardrobeEventToSteps(plan.wardrobeEvents![0], plan).join(' ')).not.toMatch(/unbuttons/i);

    const closed: ContinuityPlan = {
      characters: [{
        name: 'Tay',
        wardrobe: {
          layers: [{ id: 'coat', item: 'tan sherpa coat', order: 1, inReference: 'visible' }],
        },
      }],
      shotCount: 1,
    };
    expect(expandWardrobeEventToSteps(
      { shot: 1, action: 'remove', layer: 'coat' },
      closed,
    )[0]).toBe('unbuttons tan sherpa coat');
  });

  it('says shoe, not shoes, when the layer id is shoes', () => {
    const plan: ContinuityPlan = {
      characters: [{
        name: 'Tay',
        wardrobe: {
          layers: [{ id: 'shoes', item: 'black slip-on dress shoes', order: 1, inReference: 'visible', type: 'footwear' }],
          startState: { worn: ['shoes'] },
        },
      }],
      shotCount: 1,
    };
    const forbidden = deriveContracts(plan)[0].forbidden.join('; ');
    expect(forbidden).toContain('a third shoe');
    expect(forbidden).toContain('only one shoe');
    expect(forbidden).not.toContain('a third shoes');
    expect(forbidden).not.toContain('only one shoes');
  });
});

describe('the face sentence', () => {
  it('stays on for a person and stays off when the shot asks', () => {
    const hands = 'Close on his hands turning the page.';
    expect(shouldAnchorFace(hands)).toBe(true);
    expect(shouldAnchorFace(hands, { faceAnchor: 'off' })).toBe(false);
    expect(shouldAnchorFace(hands, { shotType: 'feet-close' })).toBe(false);
    expect(shouldAnchorFace(hands, { shotType: 'close-up' })).toBe(true);
    expect(shouldAnchorFace('The lamp brightens.')).toBe(false);
  });
});

describe('the voice tag', () => {
  const plan: ContinuityPlan = {
    characters: [],
    shotCount: 1,
    voiceId: 'rex',
    spokenLines: [{ shot: 1, line: 'Zipped up and cozy.' }],
    shotPrompts: [{ shot: 1, prompt: 'He says, "Zipped up and cozy." and sits.' }],
  };

  it('warns in the default mode and still passes', () => {
    const gate = gateRenderSequence({ plan });
    expect(gate.status).toBe('pass');
    expect(gate.warnings?.join(' ')).toContain('<AUDIO_0>');
    expect(gate.violations.some((entry) => entry.message.includes('<AUDIO_0>'))).toBe(false);
  });

  it('blocks only in sections-v2', () => {
    const gate = gateRenderSequence({ plan: { ...plan, promptStyle: 'sections-v2' } });
    expect(gate.status).toBe('fail');
    expect(gate.blocked).toBe(true);
    expect(gate.violations.some((entry) => entry.message.includes('<AUDIO_0>'))).toBe(true);
  });
});

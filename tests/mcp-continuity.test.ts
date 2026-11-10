/**
 * Guards the wardrobe checklist and the per-location prop ledger.
 *
 * These are the failures that matter:
 *
 *  - a removal has to leave the inner layers worn and stage the garment where
 *    it was put, not vanish it
 *  - two hangers with the same name in two rooms stay two props
 *  - a prompt after a named change describes what is actually worn
 *  - a layer that becomes outermost but was only partial in the photo warns
 *    that the model will guess
 *  - an older character file that only has `description` still loads
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  annotateAction,
  CONTINUITY_AUDIT_UNIMPLEMENTED,
  parseWardrobe,
  replayContinuity,
  unimplementedContinuityAuditor,
  type CharacterContinuity,
  type PropRecord,
} from '../mcp/continuity.ts';
import { loadCharacter, saveCharacter } from '../mcp/characters.ts';
import { planBoardFrames } from '../mcp/storyboard.ts';

const TAY: CharacterContinuity = {
  name: 'Tay',
  appearance: 'Bald head, full black beard with grey flecks at the chin, warm medium-brown skin.',
  wardrobe: {
    layers: [
      { id: 'shirt', item: 'blue and white vertical-striped button-down', order: 1, inReference: 'visible' },
      { id: 'blazer', item: 'dark blazer', order: 2, inReference: 'partial' },
      { id: 'coat', item: 'tan suede coat with cream sherpa collar', order: 3, inReference: 'visible' },
    ],
    startState: { worn: ['shirt', 'blazer', 'coat'] },
  },
};

const HANGERS: PropRecord[] = [
  { id: 'hanger-living-room', locationId: 'living-room', name: 'coat hanger', placement: 'by the door' },
  { id: 'hanger-study', locationId: 'study', name: 'coat hanger', placement: 'by the desk' },
];

const LOCATIONS = [
  { id: 'living-room', name: 'living room' },
  { id: 'study', name: 'study' },
];

function taySequence() {
  return replayContinuity({
    characters: [TAY],
    locations: LOCATIONS,
    props: HANGERS,
    shotLocations: ['living-room', 'living-room', 'living-room'],
    shotCount: 3,
    hasReferencePicture: true,
    wardrobeEvents: [
      { shot: 2, action: 'remove', layer: 'coat', to: 'hanger-living-room' },
      { shot: 3, action: 'adjust', layer: 'blazer', note: 'straightens lapels and cuffs' },
    ],
  });
}

describe('wardrobe event replay', () => {
  it('starts with every listed layer worn and the coat outermost', () => {
    const [opening] = taySequence();
    expect(opening.checklists[0].worn.map((layer) => layer.id)).toEqual(['shirt', 'blazer', 'coat']);
    expect(opening.checklists[0].outermost?.id).toBe('coat');
    expect(opening.checklists[0].staged).toEqual([]);
  });

  it('takes the coat off onto the living-room hanger and leaves the blazer outermost', () => {
    const shots = taySequence();
    const after = shots[1].checklists[0];
    expect(after.worn.map((layer) => layer.id)).toEqual(['shirt', 'blazer']);
    expect(after.outermost?.id).toBe('blazer');
    expect(after.staged).toHaveLength(1);
    expect(after.staged[0].item).toMatch(/tan suede coat/);
    expect(after.staged[0].holder).toBe('hanger-living-room');
    expect(after.staged[0].locationId).toBe('living-room');
    expect(shots[1].propsInView.some((prop) => prop.id === 'hanger-living-room')).toBe(true);
    expect(shots[1].propsInView.some((prop) => prop.name.includes('tan suede coat'))).toBe(true);
  });

  it('keeps the coat staged after a later adjust, and records the adjustment', () => {
    const shots = taySequence();
    const last = shots[2].checklists[0];
    expect(last.worn.map((layer) => layer.id)).toEqual(['shirt', 'blazer']);
    expect(last.staged[0].holder).toBe('hanger-living-room');
    expect(last.adjustments[0]).toMatchObject({
      layerId: 'blazer',
      note: 'straightens lapels and cuffs',
    });
  });

  it('puts a removed layer back on and clears the staged garment', () => {
    const shots = replayContinuity({
      characters: [TAY],
      props: HANGERS,
      shotLocations: ['living-room', 'living-room', 'living-room'],
      shotCount: 3,
      wardrobeEvents: [
        { shot: 2, action: 'remove', layer: 'coat', to: 'hanger-living-room' },
        { shot: 3, action: 'putOn', layer: 'coat' },
      ],
    });
    expect(shots[1].checklists[0].worn.map((layer) => layer.id)).toEqual(['shirt', 'blazer']);
    expect(shots[2].checklists[0].worn.map((layer) => layer.id)).toEqual(['shirt', 'blazer', 'coat']);
    expect(shots[2].checklists[0].staged).toEqual([]);
    expect(shots[2].propsInView.some((prop) => prop.name.includes('tan suede coat'))).toBe(false);
  });
});

describe('per-location prop scoping', () => {
  it('does not let the living-room hanger and the study hanger collapse into one', () => {
    const shots = replayContinuity({
      characters: [TAY],
      locations: LOCATIONS,
      props: HANGERS,
      shotLocations: ['living-room', 'study'],
      shotCount: 2,
      wardrobeEvents: [
        { shot: 1, action: 'remove', layer: 'coat', to: 'coat hanger' },
      ],
    });

    const living = shots[0].propsInView;
    const study = shots[1].propsInView;
    expect(living.map((prop) => prop.id)).toContain('hanger-living-room');
    expect(living.map((prop) => prop.id)).not.toContain('hanger-study');
    expect(study.map((prop) => prop.id)).toContain('hanger-study');
    expect(study.map((prop) => prop.id)).not.toContain('hanger-living-room');

    const staged = shots[0].checklists[0].staged[0];
    expect(staged.holder).toBe('hanger-living-room');
    expect(staged.locationId).toBe('living-room');
    expect(shots[1].checklists[0].staged[0].locationId).toBe('living-room');
  });

  it('never removes a prop that was not named by id', () => {
    const shots = replayContinuity({
      characters: [TAY],
      props: HANGERS,
      shotLocations: ['living-room'],
      shotCount: 1,
      propEvents: [
        { shot: 1, action: 'remove', propId: '' },
      ],
    });
    expect(shots[0].propsInView.map((prop) => prop.id)).toContain('hanger-living-room');
    expect(shots[0].warnings.join(' ')).toMatch(/no prop id/i);
  });
});

describe('prompt text from the checklist', () => {
  it('does not name garments on a shot that still matches the reference picture', () => {
    const [opening] = taySequence();
    expect(opening.prompt).toMatch(/Fixed set dressing in the living room/);
    expect(opening.prompt).toMatch(/coat hanger/);
    expect(opening.prompt).not.toMatch(/is wearing/);
    expect(opening.prompt).not.toMatch(/navy/i);
  });

  it('names the change, the worn stack, and the staged coat once it comes off', () => {
    const shots = taySequence();
    expect(shots[1].prompt).toMatch(/takes off the tan suede coat with cream sherpa collar/i);
    expect(shots[1].prompt).toMatch(/Tay is wearing blue and white vertical-striped button-down and dark blazer \(now outermost\)/);
    expect(shots[1].prompt).toMatch(/tan suede coat with cream sherpa collar is on the coat hanger/i);
    expect(shots[1].prompt).not.toMatch(/navy/i);
    expect(shots[2].prompt).toMatch(/adjusts the dark blazer/i);
    expect(shots[2].prompt).toMatch(/straightens lapels and cuffs/);
  });

  it('folds that wording into board frames and treats a structured event as a named change', () => {
    const shots = taySequence();
    const frames = planBoardFrames({
      shots: [
        { prompt: 'Tay stands by the door.', continuityPrompt: shots[0].prompt },
        {
          prompt: 'Tay hangs up his coat.',
          continuityPrompt: shots[1].prompt,
          wardrobeChanged: true,
        },
        { prompt: 'Tay straightens his jacket.', continuityPrompt: shots[2].prompt, wardrobeChanged: true },
      ],
      aspectRatio: '16:9',
      cast: 'bald man, black beard, striped shirt, tan sherpa coat',
      baseImageUrl: '/refs/tay.jpg',
    });

    expect(frames[0].prompt).toContain('Fixed set dressing in the living room');
    expect(frames[0].prompt).toContain('exactly as the reference picture shows them');
    expect(frames[1].prompt).toContain('takes off the tan suede coat');
    expect(frames[1].prompt).toContain('asks for the clothing change it names');
    expect(frames[1].prompt).not.toContain('never restyle them');
    expect(frames[2].prompt).toContain('straightens lapels and cuffs');
  });
});

describe('the hidden-layer warning', () => {
  it('warns when the blazer becomes outermost and no coat-off photo exists', () => {
    const shots = taySequence();
    expect(shots[0].warnings).toEqual([]);
    expect(shots[1].warnings.join(' ')).toMatch(/outermost layer is dark blazer/i);
    expect(shots[1].warnings.join(' ')).toMatch(/only in part/i);
    expect(shots[1].warnings.join(' ')).toMatch(/will have to guess/i);
  });

  it('stays silent when a state photo covers the new stack', () => {
    const withPhoto: CharacterContinuity = {
      ...TAY,
      wardrobe: {
        ...TAY.wardrobe!,
        stateImages: [{
          worn: ['shirt', 'blazer'],
          referenceImageUrls: ['/refs/tay-coat-off.jpg'],
        }],
      },
    };
    const shots = replayContinuity({
      characters: [withPhoto],
      props: HANGERS,
      shotLocations: ['living-room', 'living-room'],
      shotCount: 2,
      wardrobeEvents: [
        { shot: 2, action: 'remove', layer: 'coat', to: 'hanger-living-room' },
      ],
    });
    expect(shots[1].warnings.join(' ')).not.toMatch(/will have to guess/i);
  });
});

describe('backward compatibility', () => {
  it('parses nothing from a file that only has a description', () => {
    expect(parseWardrobe(undefined)).toBeUndefined();
    expect(parseWardrobe({ description: 'Tall, grey beard, sheepskin coat.' })).toBeUndefined();
  });

  it('still loads a description-only character from disk', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'theshow-legacy-char-'));
    process.env.THESHOW_CHARACTERS_DIR = root;
    try {
      const saved = await saveCharacter({
        name: 'Dad',
        description: 'Tall, grey beard, sheepskin coat.',
      });
      const raw = JSON.parse(readFileSync(path.join(saved.folder, 'character.json'), 'utf8'));
      expect(raw.wardrobe).toBeUndefined();
      expect(raw.appearance).toBeUndefined();
      expect(raw.description).toBe('Tall, grey beard, sheepskin coat.');

      const loaded = await loadCharacter('Dad');
      expect(loaded?.description).toBe('Tall, grey beard, sheepskin coat.');
      expect(loaded?.wardrobe).toBeUndefined();
    } finally {
      delete process.env.THESHOW_CHARACTERS_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips a layered wardrobe through character.json', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'theshow-layered-char-'));
    process.env.THESHOW_CHARACTERS_DIR = root;
    try {
      await saveCharacter({
        name: 'Tay',
        appearance: TAY.appearance,
        wardrobe: TAY.wardrobe,
      });
      const loaded = await loadCharacter('Tay');
      expect(loaded?.appearance).toBe(TAY.appearance);
      expect(loaded?.wardrobe?.layers.map((layer) => layer.id)).toEqual(['shirt', 'blazer', 'coat']);
      expect(loaded?.wardrobe?.startState?.worn).toEqual(['shirt', 'blazer', 'coat']);
    } finally {
      delete process.env.THESHOW_CHARACTERS_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not rewrite an annotated action that already carries the checklist', () => {
    const extra = 'Tay takes off the coat.';
    const once = annotateAction('Tay stands by the door.', extra);
    expect(annotateAction(once, extra)).toBe(once);
  });
});

describe('the post-render audit stub', () => {
  it('refuses to run rather than invent a vision call', async () => {
    const auditor = unimplementedContinuityAuditor();
    await expect(auditor.auditShot({
      shotIndex: 1,
      framePaths: [],
      expected: taySequence()[0],
    })).rejects.toThrow(CONTINUITY_AUDIT_UNIMPLEMENTED);
  });
});

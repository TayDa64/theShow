/**
 * Guards per-shot state-file contracts: requires, steps, ensures, invariants,
 * and forbidden items.
 *
 * These are the failures that matter:
 *
 *  - a shot's start state has to be the previous shot's end state
 *  - more than three atomic steps in one shot has to be split
 *  - a garment cannot be worn and hanging at the same time
 *  - footwear is a pair, so a count of one or three is wrong
 *  - the old coat-and-shoes montage, with too many steps and a blazer that
 *    vanishes and reappears, has to fail before any video is paid for
 */
import { describe, expect, it } from 'vitest';

import {
  annotateAction,
  replayContinuity,
  unimplementedContinuityAuditor,
  type ContinuityAuditor,
  type ContinuityPlan,
} from '../mcp/continuity.ts';
import {
  MAX_STEPS_PER_SHOT,
  RENDER_BLOCKED_BY_CONTRACT,
  createContinuityAuditor,
  deriveContracts,
  gateRenderSequence,
  promptFromContract,
  runPreVideoGate,
  validateContracts,
  validateContractsAgainstPlan,
  type ShotContract,
} from '../mcp/contracts.ts';
import {
  flawedTayArrivalContracts,
  oldSingleShotCoatPlan,
  tayArrivalMontagePlan,
} from '../mcp/examples/tay-coat-montage.ts';
import { planBoardFrames } from '../mcp/storyboard.ts';

describe('deriving contracts from the ledger', () => {
  it('replays start and end state so requires of shot N match ensures of shot N-1', () => {
    const plan = tayArrivalMontagePlan();
    const contracts = deriveContracts(plan);

    expect(contracts.map((entry) => entry.shot)).toEqual([1, 2, 3, 4]);
    for (let index = 1; index < contracts.length; index += 1) {
      expect(contracts[index].requires).toEqual(contracts[index - 1].ensures);
    }

    expect(contracts[0].requires.worn).toEqual(['shirt', 'blazer', 'coat', 'street-shoes']);
    expect(contracts[0].requires.holders['hanger-living-room']).toMatch(/empty/i);

    expect(contracts[1].ensures.worn).toEqual(['shirt', 'blazer', 'street-shoes']);
    expect(contracts[1].ensures.holders['hanger-living-room']).toMatch(/empty/i);

    expect(contracts[2].ensures.worn).toEqual(['shirt', 'blazer', 'street-shoes']);
    expect(contracts[2].ensures.holders['hanger-living-room']).toMatch(/holding/i);
    expect(contracts[2].ensures.holders['hanger-living-room']).toMatch(/coat/i);

    expect(contracts[3].ensures.worn).toEqual(['shirt', 'blazer', 'house-shoes']);
    expect(contracts[3].ensures.worn).not.toContain('street-shoes');
  });

  it('uses explicit shot steps when they are provided', () => {
    const contracts = deriveContracts(tayArrivalMontagePlan());
    expect(contracts[1].steps).toEqual(['unbuttons coat', 'removes coat']);
    expect(contracts[2].steps).toEqual([
      'lifts hanger off wall',
      'hangs coat on hanger',
      'returns hanger to wall',
    ]);
    expect(contracts[3].steps).toEqual([
      'removes both street shoes',
      'puts on both house shoes',
    ]);
  });

  it('hangs a coat on the rail without lifting the hanger off it', () => {
    const contracts = deriveContracts(oldSingleShotCoatPlan());
    const coatShot = contracts.find((entry) => entry.shot === 2);
    expect(coatShot?.steps.length).toBeLessThanOrEqual(MAX_STEPS_PER_SHOT);
    expect(coatShot?.steps.join(' ')).toMatch(/unbuttons/i);
    expect(coatShot?.steps.join(' ')).toMatch(/removes/i);
    expect(coatShot?.steps.join(' ')).toMatch(/hanger stays on the rail/i);
    expect(coatShot?.steps.join(' ')).not.toMatch(/lifts hanger off wall/i);
  });

  it('marks unchanged layers as worn the whole shot and counts footwear as a pair', () => {
    const [opening, coatOff] = deriveContracts(tayArrivalMontagePlan());

    expect(opening.invariants).toContain('tan suede coat with cream sherpa collar worn the whole shot');
    expect(opening.invariants).toContain('dark blazer worn the whole shot');
    expect(opening.invariants).toContain('exactly 2 street shoes, on feet');
    expect(opening.invariants).toContain('exactly one tan suede coat with cream sherpa collar in frame');

    expect(coatOff.invariants).toContain('dark blazer worn the whole shot');
    expect(coatOff.invariants).not.toContain('tan suede coat with cream sherpa collar worn the whole shot');
    expect(coatOff.invariants).toContain('exactly one tan suede coat with cream sherpa collar in frame');
    expect(coatOff.invariants).toContain('exactly 2 street shoes, on feet');
    expect(coatOff.forbidden).toContain('second coat');
    expect(coatOff.forbidden).toContain('blazer on hanger');
  });
});

describe('the contract validator', () => {
  it('accepts the split Tay coat and shoes montage', () => {
    const plan = tayArrivalMontagePlan();
    const result = validateContractsAgainstPlan(plan);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects more than three steps and suggests a split', () => {
    const plan = oldSingleShotCoatPlan();
    plan.shotSteps = [{ shot: 2, steps: ['one', 'two', 'three', 'four'] }];
    const derived = deriveContracts(plan);
    const result = validateContracts(derived);
    expect(result.ok).toBe(false);
    const tooMany = result.violations.find((entry) => entry.code === 'too-many-steps');
    expect(tooMany).toBeDefined();
    expect(tooMany?.shot).toBe(2);
    expect(tooMany?.suggestSplit).toBe(true);
    expect(tooMany?.message).toMatch(/more than 3/i);
    expect(tooMany?.message).toMatch(/split/i);
  });

  it('rejects a requires that does not match the previous ensures', () => {
    const result = validateContracts(flawedTayArrivalContracts());
    expect(result.ok).toBe(false);
    const chain = result.violations.find((entry) => entry.code === 'requires-mismatch');
    expect(chain).toBeDefined();
    expect(chain?.shot).toBe(3);
    expect(chain?.message).toMatch(/blazer/i);
  });

  it('catches the old flawed montage: too many coat steps and a blazer that reappears', () => {
    const result = validateContracts(flawedTayArrivalContracts());
    const codes = result.violations.map((entry) => entry.code);
    expect(codes).toContain('too-many-steps');
    expect(codes).toContain('requires-mismatch');
  });

  it('rejects a garment that is both worn and on a holder', () => {
    const contract: ShotContract = {
      shot: 1,
      requires: {
        worn: ['shirt', 'coat'],
        holders: { 'hanger-living-room': 'empty, on the wall' },
        counts: { shirt: 1, coat: 1 },
      },
      steps: ['stands still'],
      ensures: {
        worn: ['shirt', 'coat'],
        holders: { 'hanger-living-room': 'on the wall, holding tan suede coat with cream sherpa collar' },
        counts: { shirt: 1, coat: 2 },
      },
      invariants: ['exactly one tan suede coat with cream sherpa collar in frame'],
      forbidden: ['second coat'],
    };
    const result = validateContracts([contract]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'worn-and-held')).toBe(true);
  });

  it('rejects duplicate garment instances', () => {
    const contract: ShotContract = {
      shot: 1,
      requires: {
        worn: ['coat'],
        holders: { 'hanger-living-room': 'empty, on the wall' },
        counts: { coat: 1 },
      },
      steps: ['stands still'],
      ensures: {
        worn: ['coat'],
        holders: { 'hanger-living-room': 'on the wall, holding coat' },
        counts: { coat: 2 },
      },
      invariants: [],
      forbidden: [],
    };
    const result = validateContracts([contract]);
    expect(result.violations.some((entry) => entry.code === 'duplicate-garment')).toBe(true);
  });

  it('rejects footwear counts that do not add up to a pair', () => {
    const contract: ShotContract = {
      shot: 1,
      requires: {
        worn: ['street-shoes'],
        holders: {},
        counts: { 'street-shoes': 2 },
      },
      steps: ['stands still'],
      ensures: {
        worn: ['street-shoes'],
        holders: {},
        counts: { 'street-shoes': 3 },
      },
      invariants: ['exactly 3 street shoes, on feet'],
      forbidden: [],
      footwear: ['street-shoes'],
    };
    const result = validateContracts([contract]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'footwear-count')).toBe(true);
  });
});

describe('the contract prompt builder', () => {
  it('writes invariants word for word, names steps in order, and adds a forbidden clause', () => {
    const [opening, coatOff] = deriveContracts(tayArrivalMontagePlan());
    const text = promptFromContract(coatOff);

    for (const invariant of coatOff.invariants) {
      expect(text).toContain(invariant);
    }
    expect(text).toMatch(/Steps in order:/);
    expect(text.indexOf('unbuttons coat')).toBeLessThan(text.indexOf('removes coat'));
    expect(text).toMatch(/Do not show:/);
    for (const item of coatOff.forbidden) {
      expect(text).toContain(item);
    }

    const annotated = annotateAction('Tay takes off his coat.', promptFromContract(opening));
    expect(annotated).toContain('exactly 2 street shoes, on feet');
  });
});

describe('the pre-video gate and the auditor interface', () => {
  it('blocks render_sequence when the old montage fails validation', () => {
    const plan: ContinuityPlan = oldSingleShotCoatPlan();
    plan.shotSteps = [{ shot: 2, steps: ['one', 'two', 'three', 'four'] }];
    const gate = gateRenderSequence({ plan });
    expect(gate.ok).toBe(false);
    expect(gate.blocked).toBe(true);
    expect(gate.message).toBe(RENDER_BLOCKED_BY_CONTRACT);
    expect(runPreVideoGate({ plan }).blocked).toBe(true);
  });

  it('does not start when contracts fail, unless the caller overrides', () => {
    const blocked = gateRenderSequence({ contracts: flawedTayArrivalContracts() });
    expect(blocked.blocked).toBe(true);

    const overridden = gateRenderSequence({
      contracts: flawedTayArrivalContracts(),
      overrideValidation: true,
    });
    expect(overridden.ok).toBe(false);
    expect(overridden.blocked).toBe(false);
    expect(overridden.violations.length).toBeGreaterThan(0);
  });

  it('refuses a film when there is no ledger or contract to check', () => {
    const gate = gateRenderSequence({});
    expect(gate.ok).toBe(false);
    expect(gate.blocked).toBe(true);
    expect(gate.status).toBe('unchecked');
    expect(gate.violations.some((entry) => entry.code === 'unchecked')).toBe(true);
  });

  it('keeps the vision auditor as an injectable stub that never spends', async () => {
    const stub = createContinuityAuditor();
    await expect(stub.auditShot({
      shotIndex: 1,
      framePaths: [],
      expected: replayContinuity(tayArrivalMontagePlan())[0],
      contract: deriveContracts(tayArrivalMontagePlan())[0],
    })).rejects.toThrow(/not implemented/i);

    const seen: number[] = [];
    const fake: ContinuityAuditor = {
      async auditShot(input) {
        seen.push(input.shotIndex);
        return [];
      },
    };
    const injected = createContinuityAuditor(fake);
    expect(await injected.auditShot({
      shotIndex: 2,
      framePaths: [],
      expected: replayContinuity(tayArrivalMontagePlan())[1],
    })).toEqual([]);
    expect(seen).toEqual([2]);
    expect(unimplementedContinuityAuditor).toBeTypeOf('function');
  });
});

describe('an optional middle keyframe on the board', () => {
  it('inserts one extra still inside a shot that asks for a midpoint, and leaves the rest as shared boundaries', () => {
    const shots = [
      { prompt: 'Tay stands by the door in his coat.', middleKeyframe: false },
      { prompt: 'Tay unbuttons and removes his coat.', middleKeyframe: true },
      { prompt: 'Tay hangs the coat on the hanger.', middleKeyframe: false },
    ];
    const withMiddle = planBoardFrames({ shots, aspectRatio: '16:9' });
    const without = planBoardFrames({
      shots: shots.map(({ prompt }) => ({ prompt })),
      aspectRatio: '16:9',
    });

    expect(without).toHaveLength(4);
    expect(withMiddle).toHaveLength(5);
    const middle = withMiddle.find((frame) => frame.role === 'middle');
    expect(middle).toBeDefined();
    expect(middle?.shot).toBe(2);
    expect(middle?.prompt).toMatch(/Middle frame of shot 2/);
    expect(withMiddle.filter((frame) => frame.role !== 'middle').map((frame) => {
      return frame.prompt.replace(/\s+/g, ' ').trim();
    })).toEqual(without.map((frame) => frame.prompt.replace(/\s+/g, ' ').trim()));
  });
});

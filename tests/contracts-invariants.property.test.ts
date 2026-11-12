/**
 * Hand-written contracts and weighted tier-0 checks.
 *
 * These are the probes that used to pass: an under-count, a rewritten
 * invariant, emptied forbidden lists, a second hanger, a removed sofa, and a
 * swapped garment name.
 */
import { describe, expect, it } from 'vitest';
import type { ContinuityPlan } from '../mcp/continuity.ts';
import {
  deriveContracts,
  gateRenderSequence,
  validateContractsAgainstPlan,
} from '../mcp/contracts.ts';
import { tayArrivalMontagePlan } from '../mcp/examples/tay-coat-montage.ts';

function codes(plan: ContinuityPlan, mutate?: (contracts: ReturnType<typeof deriveContracts>) => void) {
  const contracts = deriveContracts(plan);
  mutate?.(contracts);
  const result = validateContractsAgainstPlan(plan, contracts);
  return result;
}

describe('authored contracts cannot bypass the ledger', () => {
  it('rejects an under-count of a coat that is still worn', () => {
    const result = codes(tayArrivalMontagePlan(), (contracts) => {
      contracts[0].requires.counts.coat = 0;
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'count' || entry.code === 'ledger-mismatch')).toBe(true);
  });

  it('rejects a clothing invariant that counts two of one garment', () => {
    const result = codes(tayArrivalMontagePlan(), (contracts) => {
      contracts[0].invariants = contracts[0].invariants.map((line) =>
        line.replace('exactly one tan suede coat', 'exactly 2 tan suede coat'),
      );
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'garment-integrity')).toBe(true);
  });

  it('rejects emptied invariants and forbidden lists', () => {
    const result = codes(tayArrivalMontagePlan(), (contracts) => {
      for (const contract of contracts) {
        contract.invariants = [];
        contract.forbidden = [];
      }
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'ledger-mismatch' || entry.code === 'garment-integrity')).toBe(true);
  });

  it('rejects a garment whose identity text was swapped', () => {
    const result = codes(tayArrivalMontagePlan(), (contracts) => {
      contracts[0].invariants = contracts[0].invariants.map((line) =>
        line.replace('tan suede coat with cream sherpa collar', 'navy blazer'),
      );
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'garment-integrity')).toBe(true);
  });
});

describe('tier 0 set, contact, speech, scale, and vision', () => {
  it('rejects a second coat hanger in the same room', () => {
    const plan = tayArrivalMontagePlan();
    plan.props = [
      ...(plan.props ?? []),
      { id: 'hanger-extra', locationId: 'living-room', name: 'coat hanger', placement: 'on the wall' },
    ];
    const result = validateContractsAgainstPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'count')).toBe(true);
  });

  it('rejects removal of a fixed sofa', () => {
    const plan = tayArrivalMontagePlan();
    plan.props = [
      ...(plan.props ?? []),
      { id: 'sofa', locationId: 'living-room', name: 'sofa', placement: 'against the wall', fixed: true },
    ];
    plan.propEvents = [
      ...(plan.propEvents ?? []),
      { shot: 3, action: 'remove', propId: 'sofa' },
    ];
    const result = validateContractsAgainstPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'set-geometry')).toBe(true);
  });

  it('rejects a door that moves while the body is inside its swing', () => {
    const plan: ContinuityPlan = {
      characters: [],
      props: [{
        id: 'door',
        locationId: 'living-room',
        name: 'door',
        placement: 'at the entry',
        solid: true,
      }],
      propEvents: [{ shot: 1, action: 'move', propId: 'door', placement: 'closed across the mark' }],
      bodyClearance: [{ shot: 1, solidId: 'door', clear: false }],
      shotLocations: ['living-room'],
      shotCount: 1,
      humanVisionSignOff: true,
    };
    const result = validateContractsAgainstPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.violations.some((entry) => entry.code === 'contact')).toBe(true);
  });

  it('fails closed on a solid piece until a person signs the vision stub', () => {
    const plan: ContinuityPlan = {
      characters: [],
      props: [{
        id: 'bench',
        locationId: 'living-room',
        name: 'bench',
        placement: 'under the window',
        solid: true,
        fixed: true,
        bbox: [598, 535, 682, 162],
      }],
      shotLocations: ['living-room'],
      shotCount: 1,
    };
    const blocked = gateRenderSequence({ plan });
    expect(blocked.blocked).toBe(true);
    expect(blocked.vision).toBe('fail-closed');
    expect(blocked.violations.some((entry) => entry.code === 'vision-unchecked')).toBe(true);

    const signed = gateRenderSequence({ plan: { ...plan, humanVisionSignOff: true } });
    expect(signed.vision).toBe('human-signed-off');
    expect(signed.blocked).toBe(false);
  });

  it('rejects a body height outside the mark and a line that is not verbatim', () => {
    const plan: ContinuityPlan = {
      characters: [],
      shotCount: 1,
      scaleMarks: [{ shot: 1, bodyH: 410, tolPct: 4, measuredBodyH: 470 }],
      spokenLines: [{ shot: 1, line: 'Zipped up and cozy.' }],
      shotPrompts: [{ shot: 1, prompt: 'He smiles and says something else.' }],
      humanVisionSignOff: true,
    };
    const result = validateContractsAgainstPlan(plan);
    expect(result.violations.some((entry) => entry.code === 'scale')).toBe(true);
    expect(result.violations.some((entry) => entry.code === 'speech-verbatim')).toBe(true);
    expect(result.violations.some((entry) => entry.code === 'voice')).toBe(true);
  });

  it('accepts rex and the exact line', () => {
    const plan: ContinuityPlan = {
      characters: [],
      shotCount: 1,
      voiceId: 'rex',
      spokenLines: [{ shot: 1, line: 'Zipped up and cozy.' }],
      shotPrompts: [{ shot: 1, prompt: 'He says, "Zipped up and cozy." and sits.' }],
    };
    const gate = gateRenderSequence({ plan });
    expect(gate.status).toBe('pass');
    expect(gate.tier2).toBe('style-only');
  });

  it('scores tier 1 and ignores style notes', () => {
    const failing: ContinuityPlan = {
      characters: [],
      shotCount: 1,
      tier1: { freezeRun: 0, speechCoverage: 0, joinSsim: 0, motionNatural: 0 },
      styleNotes: ['warmer light'],
    };
    const failed = gateRenderSequence({ plan: failing });
    expect(failed.blocked).toBe(true);
    expect(failed.tier1?.pass).toBe(false);

    const passing: ContinuityPlan = {
      characters: [],
      shotCount: 1,
      tier1: { freezeRun: 1, speechCoverage: 1, joinSsim: 1, motionNatural: 1 },
      styleNotes: ['this note must not fail the take'],
    };
    const passed = gateRenderSequence({ plan: passing });
    expect(passed.status).toBe('pass');
    expect(passed.tier1?.score).toBeCloseTo(1);
  });

  it('flags wardrobe with no portrait and no base picture', () => {
    const plan = tayArrivalMontagePlan();
    plan.hasReferencePicture = false;
    plan.hasPortrait = false;
    const result = validateContractsAgainstPlan(plan);
    expect(result.violations.some((entry) => entry.code === 'wardrobe-unchecked')).toBe(true);
  });

  it('rejects buttons next to a zip cardigan and a shrug that splits a coat', () => {
    const plan: ContinuityPlan = {
      characters: [{
        name: 'Tay',
        wardrobe: {
          layers: [{
            id: 'cardigan',
            item: 'beige cardigan',
            order: 1,
            inReference: 'visible',
            closure: 'zip',
            mustNotHave: ['buttons'],
          }],
          startState: { worn: ['cardigan'] },
        },
      }],
      shotCount: 1,
      hasReferencePicture: true,
      shotPrompts: [{
        shot: 1,
        prompt: 'He shrugs the beige cardigan off his shoulders, then buttons it.',
      }],
    };
    const result = validateContractsAgainstPlan(plan);
    expect(result.violations.some((entry) => entry.code === 'closure')).toBe(true);
    expect(result.violations.some((entry) => entry.code === 'garment-integrity')).toBe(true);
  });
});

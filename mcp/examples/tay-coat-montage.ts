/**
 * Sample arrival montage: Tay hangs his sherpa coat, then changes into house
 * shoes. The split plan is the one that should pass the contract validator.
 * The old single-shot coat hang, and the authored flawed contracts, are the
 * plans the validator has to catch.
 */
import type { CharacterContinuity, ContinuityPlan, PropRecord } from "../continuity.ts";
import type { ShotContract, ShotState } from "../contracts.ts";

export const TAY_ARRIVAL: CharacterContinuity = {
  name: "Tay",
  appearance: "Bald head, full black beard with grey flecks at the chin, warm medium-brown skin.",
  wardrobe: {
    layers: [
      { id: "shirt", item: "blue and white vertical-striped button-down", order: 1, inReference: "visible" },
      { id: "blazer", item: "dark blazer", order: 2, inReference: "partial" },
      { id: "coat", item: "tan suede coat with cream sherpa collar", order: 3, inReference: "visible" },
      { id: "street-shoes", item: "street shoes", order: 1, inReference: "hidden", type: "footwear" },
      { id: "house-shoes", item: "house shoes", order: 1, inReference: "hidden", type: "footwear" },
    ],
    startState: { worn: ["shirt", "blazer", "coat", "street-shoes"] },
  },
};

export const LIVING_ROOM = { id: "living-room", name: "living room" };

export const ARRIVAL_PROPS: PropRecord[] = [
  { id: "hanger-living-room", locationId: "living-room", name: "coat hanger", placement: "on the wall" },
  { id: "house-shoes-pair", locationId: "living-room", name: "house shoes", placement: "beside the chair" },
];

const LIVING = ["living-room", "living-room", "living-room", "living-room"] as Array<string | undefined>;

export function tayArrivalMontagePlan(): ContinuityPlan {
  return {
    characters: [TAY_ARRIVAL],
    locations: [LIVING_ROOM],
    props: ARRIVAL_PROPS,
    shotLocations: LIVING,
    shotCount: 4,
    hasReferencePicture: true,
    wardrobeEvents: [
      { shot: 2, action: "remove", layer: "coat", to: "in his hands" },
      { shot: 4, action: "remove", layer: "street-shoes", to: "beside the chair" },
      { shot: 4, action: "putOn", layer: "house-shoes" },
    ],
    propEvents: [
      {
        shot: 3,
        action: "move",
        propId: "garment-tay-coat",
        placement: "on the coat hanger, on the wall",
        holder: "hanger-living-room",
      },
      { shot: 4, action: "remove", propId: "house-shoes-pair" },
    ],
    shotSteps: [
      { shot: 1, steps: ["stands by the door"] },
      { shot: 2, steps: ["unbuttons coat", "removes coat"] },
      {
        shot: 3,
        steps: ["lifts hanger off wall", "hangs coat on hanger", "returns hanger to wall"],
      },
      { shot: 4, steps: ["removes both street shoes", "puts on both house shoes"] },
    ],
  };
}

/**
 * The earlier plan: take the coat off and hang it in one shot. Replay expands
 * that into more than three physical steps, which the validator rejects.
 */
export function oldSingleShotCoatPlan(): ContinuityPlan {
  return {
    characters: [TAY_ARRIVAL],
    locations: [LIVING_ROOM],
    props: ARRIVAL_PROPS,
    shotLocations: ["living-room", "living-room", "living-room"],
    shotCount: 3,
    hasReferencePicture: true,
    wardrobeEvents: [
      { shot: 2, action: "remove", layer: "coat", to: "hanger-living-room" },
      { shot: 3, action: "remove", layer: "street-shoes", to: "beside the chair" },
      { shot: 3, action: "putOn", layer: "house-shoes" },
    ],
    propEvents: [
      { shot: 3, action: "remove", propId: "house-shoes-pair" },
    ],
  };
}

function state(worn: string[], holders: Record<string, string>, counts: Record<string, number>): ShotState {
  return { worn, holders, counts };
}

/**
 * What the first coat-and-shoes render actually did: five coat steps in one
 * shot, then a shoe change that puts the blazer back after the hang left Tay
 * in only the striped shirt.
 */
export function flawedTayArrivalContracts(): ShotContract[] {
  const emptyHanger = { "hanger-living-room": "empty, on the wall" };
  const hangingCoat = {
    "hanger-living-room": "on the wall, holding tan suede coat with cream sherpa collar",
  };
  const startWorn = ["shirt", "blazer", "coat", "street-shoes"];
  const startCounts = { shirt: 1, blazer: 1, coat: 1, "street-shoes": 2, "house-shoes": 2 };
  const footwear = ["street-shoes", "house-shoes"];

  const opening: ShotContract = {
    shot: 1,
    requires: state(startWorn, emptyHanger, startCounts),
    steps: ["stands by the door"],
    ensures: state(startWorn, emptyHanger, startCounts),
    invariants: ["dark blazer worn the whole shot", "exactly 2 street shoes, on feet"],
    forbidden: ["second coat", "blazer on hanger"],
    footwear,
  };

  const coatHang: ShotContract = {
    shot: 2,
    requires: state(startWorn, emptyHanger, startCounts),
    steps: [
      "unbuttons coat",
      "removes coat",
      "lifts hanger off wall",
      "hangs coat on hanger",
      "returns hanger to wall",
    ],
    ensures: state(
      ["shirt", "street-shoes"],
      hangingCoat,
      { shirt: 1, blazer: 0, coat: 1, "street-shoes": 2, "house-shoes": 2 },
    ),
    invariants: ["exactly one tan suede coat with cream sherpa collar in frame"],
    forbidden: ["second coat"],
    footwear,
  };

  const shoes: ShotContract = {
    shot: 3,
    requires: state(
      ["shirt", "blazer", "street-shoes"],
      hangingCoat,
      { shirt: 1, blazer: 1, coat: 1, "street-shoes": 2, "house-shoes": 2 },
    ),
    steps: ["removes both street shoes", "puts on both house shoes"],
    ensures: state(
      ["shirt", "blazer", "house-shoes"],
      hangingCoat,
      { shirt: 1, blazer: 1, coat: 1, "street-shoes": 2, "house-shoes": 2 },
    ),
    invariants: ["dark blazer worn the whole shot", "exactly 2 street shoes in frame"],
    forbidden: ["a third street shoe", "only one street shoe"],
    footwear,
  };

  return [opening, coatHang, shoes];
}

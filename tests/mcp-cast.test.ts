import { describe, expect, it } from "vitest";
import { castClauses, castForPicture, identityOnly, namesGarment } from "../mcp/cast.js";

describe("the cast line for a board edited from a picture", () => {
  it("drops the garment that was never in the photograph", () => {
    // The exact line that produced a navy blazer out of a tan coat, on a board
    // where no shot prompt mentioned a blazer at all.
    const cast =
      "Tay: bald head, full black beard with grey flecks at the chin, warm medium-brown skin, " +
      "blue and white vertical-striped button-down shirt under a tan sherpa-collar jacket " +
      "with a dark navy blazer beneath it";
    const out = castForPicture(cast);
    expect(out).not.toMatch(/blazer/i);
    expect(out).not.toMatch(/sherpa/i);
    expect(out).not.toMatch(/striped/i);
    expect(out).not.toMatch(/shirt/i);
    // ...and keeps the part a face pass can check.
    expect(out).toMatch(/bald head/);
    expect(out).toMatch(/black beard/);
    expect(out).toMatch(/medium-brown skin/);
  });

  it("tells the model to take clothing from the picture and infer none", () => {
    const out = castForPicture("one man, grey beard, black double-breasted coat");
    expect(out).toMatch(/clothing is whatever the reference picture shows/i);
    expect(out).toMatch(/do not add, swap, layer or remove any garment/i);
  });

  it("never leaves the cast empty-handed when it is all clothing", () => {
    const out = castForPicture("navy blazer, striped shirt, brown boots");
    expect(out).toMatch(/the person in it/i);
    expect(out).not.toMatch(/blazer/i);
  });

  it("leaves a cast with no garments alone", () => {
    const out = castForPicture("a woman with red hair and freckles");
    expect(out).toMatch(/red hair and freckles/);
  });
});

describe("garment detection", () => {
  it("catches the words that invented a second layer", () => {
    for (const word of ["blazer", "sherpa-collar jacket", "button-down shirt", "trousers", "boots", "collar", "sleeves"]) {
      expect(namesGarment(`he has a ${word}`)).toBe(true);
    }
  });

  it("does not fire on the body itself", () => {
    for (const word of ["bald head", "full black beard", "warm medium-brown skin", "broad shoulders", "tall"]) {
      expect(namesGarment(word)).toBe(false);
    }
  });
});

describe("clause splitting", () => {
  it("splits on commas and sentence ends", () => {
    expect(castClauses("bald head, black beard. tall; lean")).toHaveLength(4);
  });

  it("keeps a garment clause out of the identity", () => {
    expect(identityOnly("bald head, navy blazer, black beard")).toBe("bald head, black beard");
  });
});

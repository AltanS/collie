import { describe, expect, it } from "vitest";

import { fixtureRows, readScreen } from "../../test/surface-corpus";
import { findInputFrame } from "./frame";
import { requireProfile } from "./profile";
import { isFree } from "./surface";

// The mcode idle block against the one real capture that exists (fixtures/panes/README.md, MiniMax
// Code 0.7.7 on herdr-core 0.1.21, plain text as herdr-core reads it): the composer between the two
// rules is found, it reads empty on the welcome screen, and the screen reads free. A draft row in
// that composer keeps the screen from free, which is what a suggestion is on a plain-text read.
describe("the mcode idle profile on a real screen", () => {
  const PROFILE = requireProfile("mcode").idle;

  it("finds the composer between the rules, empty, on the welcome screen", () => {
    const rows = fixtureRows("mcode--v077-idle-w200.txt");
    const frame = findInputFrame(rows, PROFILE);
    expect(frame).not.toBeNull();
    const read = readScreen(rows, "mcode", PROFILE);
    expect(read.surface.composer).toBe("empty");
    expect(read.surface.turn).toBe("idle");
    expect(isFree(read.surface)).toBe(true);
  });

  it("reads the suggested next message as a draft, never free", () => {
    const rows = fixtureRows("mcode--v077-turn-suggestion-w200.txt");
    expect(findInputFrame(rows, PROFILE)).not.toBeNull();
    const read = readScreen(rows, "mcode", PROFILE);
    expect(read.surface.composer).toBe("draft");
    expect(isFree(read.surface)).toBe(false);
  });
});

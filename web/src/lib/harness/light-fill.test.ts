import { describe, expect, it } from "vitest";

import { isLightFill, LIGHT_FILL_LUMA, NEAR_WHITE_FILL_LUMA } from "./light-fill";

// THE WHOLE POINT OF THE MODULE. Codex's band was rgb(240,240,240) when the black bar was first
// reported (#144) and the rule matched that literal; a live 0.154.0 pane paints rgb(244,244,244)
// and the literal saw nothing at all. Both sit far above the floor, and so does the next value
// Codex picks.
describe("Codex's near-white floor", () => {
  it.each([
    ["the fill #144 reported", "rgb(240,240,240)", true],
    ["the fill a live 0.154.0 pane paints", "rgb(244,244,244)", true],
    ["pure white, whatever paints it", "rgb(255,255,255)", true],
    ["Claude's selected-step highlight — a chip, not a bar", "rgb(177,185,249)", false],
    ["Codex's own diff green", "rgb(33,58,43)", false],
    ["Codex's own diff red", "rgb(74,34,34)", false],
    ["Codex's status-row grey", "rgb(65,69,76)", false],
  ])("%s", (_name, bg, expected) => {
    expect(isLightFill(bg, NEAR_WHITE_FILL_LUMA)).toBe(expected);
  });

  // Every fill in the fixture corpus is either Codex's 240 band or 188 and below (a 52-point gap);
  // 220 stands in it. If a capture ever lands between the two, this stops being free and the
  // number needs the argument again.
  it("stands in the corpus gap, not on either edge", () => {
    expect(NEAR_WHITE_FILL_LUMA).toBeGreaterThan(188);
    expect(NEAR_WHITE_FILL_LUMA).toBeLessThan(240);
  });
});

describe("omp's floor is untouched", () => {
  it.each([
    ["a pastel card", "rgb(250,250,250)", true],
    ["the dark body", "rgb(15,18,22)", false],
    ["a semantic diff", "rgb(33,58,43)", false],
  ])("%s", (_name, bg, expected) => {
    expect(isLightFill(bg, LIGHT_FILL_LUMA)).toBe(expected);
  });
});

describe("the shapes a background can arrive in", () => {
  it("reads hex as well as rgb(), and the two bright ANSI slots by name", () => {
    expect(isLightFill("#f0f0f0", NEAR_WHITE_FILL_LUMA)).toBe(true);
    expect(isLightFill("#213a2b", NEAR_WHITE_FILL_LUMA)).toBe(false);
    expect(isLightFill("var(--ansi-15)", NEAR_WHITE_FILL_LUMA)).toBe(true);
    expect(isLightFill("var(--ansi-7)", NEAR_WHITE_FILL_LUMA)).toBe(true);
  });

  it("says no to an absent or unreadable background rather than guessing", () => {
    expect(isLightFill(undefined, NEAR_WHITE_FILL_LUMA)).toBe(false);
    expect(isLightFill("", NEAR_WHITE_FILL_LUMA)).toBe(false);
    expect(isLightFill("transparent", NEAR_WHITE_FILL_LUMA)).toBe(false);
    expect(isLightFill("var(--ansi-0)", NEAR_WHITE_FILL_LUMA)).toBe(false);
  });
});

import { DRAFT_CAP_ROWS, draftCapPx } from "./draft-cap";

describe("draftCapPx", () => {
  it("stops at a fifth of the visible height with the keyboard up (the owner's phone)", () => {
    // About 500 CSS px visible, 15px draft text: five rows would be 112.5 + 10, the share is 100.
    expect(draftCapPx({ fontPx: 15, paddingPx: 10, visiblePx: 500 })).toBe(100);
  });

  it("stops at five rows on a tall screen", () => {
    // 923 CSS px visible: the share is 184.6, five 24px rows plus the padding are 132.
    expect(draftCapPx({ fontPx: 16, paddingPx: 12, visiblePx: 923 })).toBe(DRAFT_CAP_ROWS * 24 + 12);
  });

  it("is smaller than the old cap on the owner's phone", () => {
    // The old cap was min(10rem, 30dvh): 150px at 500 visible.
    expect(draftCapPx({ fontPx: 15, paddingPx: 10, visiblePx: 500 })).toBeLessThan(150);
  });

  it("never drops below one row, so the line being typed stays in sight", () => {
    expect(draftCapPx({ fontPx: 16, paddingPx: 12, visiblePx: 120 })).toBe(36);
  });

  it("follows the draft text size", () => {
    expect(draftCapPx({ fontPx: 12, paddingPx: 12, visiblePx: 2000 })).toBe(5 * 18 + 12);
  });
});

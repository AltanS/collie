import { FLING_PX_PER_MS, maxPullForAnchor, OPEN_PX, SLOP, shouldOpen } from "./use-sheet-pull";

// Pure decision table only  -  the touch-tracking half of the hook is exercised through
// agent-chat.test.tsx, which drives the real handle.
describe("shouldOpen", () => {
  it("stays closed on a short, slow pull", () => {
    expect(shouldOpen(40, 0.1)).toBe(false);
  });

  it("opens once the pull reaches OPEN_PX, regardless of speed", () => {
    expect(shouldOpen(OPEN_PX, 0)).toBe(true);
  });

  it("opens on a short pull that is a fast fling", () => {
    expect(shouldOpen(SLOP + 1, FLING_PX_PER_MS)).toBe(true);
  });

  it("never opens on a downward (zero-pull) release", () => {
    expect(shouldOpen(0, 5)).toBe(false);
  });

  it("a fling under SLOP still doesn't open  -  that's noise, not a drag", () => {
    expect(shouldOpen(SLOP, 10)).toBe(false);
  });
});

// The anchor clamp: how far a peek's TOP edge (anchor + pull) may still travel before it would
// overshoot the sheet's own max-height. Given an explicit sheetMax so the test doesn't depend on
// jsdom's innerHeight.
describe("maxPullForAnchor", () => {
  it("gives back the full ceiling when the handle sits at the viewport bottom", () => {
    expect(maxPullForAnchor(0, 600)).toBe(600);
  });

  it("subtracts what the anchor already spent", () => {
    expect(maxPullForAnchor(100, 600)).toBe(500);
  });

  it("never goes negative — an anchor past the ceiling clamps to 0, not a negative pull", () => {
    expect(maxPullForAnchor(900, 600)).toBe(0);
  });
});

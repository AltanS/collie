import { describe, expect, it } from "vitest";

import { keyboardLikelyOpen } from "./use-keyboard";

describe("keyboardLikelyOpen", () => {
  it("is closed when the height is unchanged", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });

  it("ignores small drops like the URL bar collapsing", () => {
    expect(keyboardLikelyOpen(800, 720)).toBe(false); // -80px
  });

  it("is open when the height drops past a keyboard-sized amount", () => {
    expect(keyboardLikelyOpen(800, 480)).toBe(true); // -320px
  });

  it("is closed again once the height returns to baseline", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });
});

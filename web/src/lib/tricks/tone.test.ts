import { describe, expect, it } from "vitest";

import { rowInkOf } from "./tone";

// A CHIP'S INK IN THE USAGE ROW: the row's own colour by default, only warn and danger change it.
describe("rowInkOf", () => {
  it("is the row's own ink (no class) for plain, muted, ok, accent, no tone and a word this build does not know", () => {
    for (const tone of ["plain", "muted", "ok", "accent", undefined, "teal"]) expect(rowInkOf(tone, false)).toBe("");
  });

  it("is the caution colour for warn and the notice red for danger", () => {
    expect(rowInkOf("warn", false)).toBe("text-status-working");
    expect(rowInkOf("danger", false)).toBe("text-status-blocked");
  });

  it("is the row's own ink for every tone once the chip is stale", () => {
    for (const tone of ["warn", "danger", "ok", "plain"]) expect(rowInkOf(tone, true)).toBe("");
  });
});

import { describe, expect, it } from "vitest";

import { coerceZoomPill, effectiveZoomPill, zoomPillShown } from "./zoom-pill";

describe("coerceZoomPill", () => {
  it("keeps the two choices and reads anything else as never chosen", () => {
    expect(coerceZoomPill("screen")).toBe("screen");
    expect(coerceZoomPill("off")).toBe("off");
    expect(coerceZoomPill("none")).toBeNull();
    expect(coerceZoomPill(undefined)).toBeNull();
    expect(coerceZoomPill(true)).toBeNull();
  });
});

describe("effectiveZoomPill", () => {
  it("is the device choice when made, else the theme's word, else screen", () => {
    expect(effectiveZoomPill(null, undefined)).toBe("screen");
    expect(effectiveZoomPill(null, "screen")).toBe("screen");
    expect(effectiveZoomPill(null, "none")).toBe("off");
    expect(effectiveZoomPill("screen", "none")).toBe("screen");
    expect(effectiveZoomPill("off", "screen")).toBe("off");
  });
});

describe("zoomPillShown", () => {
  it("is true only for the terminal body, and only when the choice allows it", () => {
    expect(zoomPillShown({ body: "terminal", device: null, themeWord: undefined })).toBe(true);
    expect(zoomPillShown({ body: "chat", device: null, themeWord: undefined })).toBe(false);
    expect(zoomPillShown({ body: "start", device: "screen", themeWord: undefined })).toBe(false);
    expect(zoomPillShown({ body: "terminal", device: "off", themeWord: undefined })).toBe(false);
    expect(zoomPillShown({ body: "terminal", device: null, themeWord: "none" })).toBe(false);
    expect(zoomPillShown({ body: "terminal", device: "screen", themeWord: "none" })).toBe(true);
  });
});

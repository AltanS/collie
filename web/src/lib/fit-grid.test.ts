import { clampFitSize, FIT_BOUNDS, FIT_PROBE_TEXT, fitGrid, measureMirrorGrid, sameFitSize } from "./fit-grid";

// jsdom has no layout, so the math is asserted with injected numbers, and the one DOM read is
// asserted twice: against jsdom's all-zero boxes (it must answer null, never a 0×0 lease) and against
// an element whose boxes a test states outright.

describe("fitGrid", () => {
  // A 390px phone with the mirror's px-2 scroller: 374px of content. A 10px monospace advance of
  // 6.02px (a typical system mono) and the mirror's 1.25 line height.
  const phone = {
    contentWidth: 374,
    contentHeight: 520,
    probeWidth: 6.02 * 20,
    probeChars: 20,
    lineHeight: 12.5,
  };

  it("counts whole cells across and whole lines down", () => {
    expect(fitGrid(phone)).toEqual({ cols: 62, rows: 41 });
  });

  it("floors a partial cell rather than rounding it up", () => {
    // 62.9 cells of room is 62 columns: a 63rd column is one the mirror would wrap.
    expect(fitGrid({ ...phone, contentWidth: 6.02 * 62.9 })?.cols).toBe(62);
    expect(fitGrid({ ...phone, contentHeight: 12.5 * 40.99 })?.rows).toBe(40);
  });

  it("averages the advance over the whole probe run", () => {
    // 20 glyphs measuring 121px is a 6.05px cell, not the 6px or 7px one glyph's box would round to.
    expect(fitGrid({ ...phone, probeWidth: 121 })?.cols).toBe(Math.floor(374 / 6.05));
  });

  it("answers null for a measurement that describes no layout", () => {
    expect(fitGrid({ ...phone, contentWidth: 0 })).toBeNull();
    expect(fitGrid({ ...phone, contentHeight: -4 })).toBeNull();
    expect(fitGrid({ ...phone, probeWidth: 0 })).toBeNull();
    expect(fitGrid({ ...phone, lineHeight: Number.NaN })).toBeNull();
    expect(fitGrid({ ...phone, probeChars: 0 })).toBeNull();
  });
});

describe("clampFitSize", () => {
  it("keeps a size inside the bridge's bounds unchanged", () => {
    expect(clampFitSize({ cols: 62, rows: 41 })).toEqual({ cols: 62, rows: 41 });
  });

  it("lifts a tiny mirror to the floor and caps a huge one at the ceiling", () => {
    expect(clampFitSize({ cols: 3, rows: 2 })).toEqual({ cols: FIT_BOUNDS.minCols, rows: FIT_BOUNDS.minRows });
    expect(clampFitSize({ cols: 9000, rows: 9000 })).toEqual({
      cols: FIT_BOUNDS.maxCols,
      rows: FIT_BOUNDS.maxRows,
    });
  });

  it("mirrors the bridge's bounds (ADR 0049)", () => {
    expect(FIT_BOUNDS).toEqual({ minCols: 20, maxCols: 500, minRows: 8, maxRows: 300 });
  });
});

describe("sameFitSize", () => {
  it("compares both axes", () => {
    expect(sameFitSize({ cols: 48, rows: 36 }, { cols: 48, rows: 36 })).toBe(true);
    expect(sameFitSize({ cols: 48, rows: 36 }, { cols: 48, rows: 35 })).toBe(false);
  });
});

describe("measureMirrorGrid", () => {
  function probeOf(width: number, height: number): HTMLSpanElement {
    const probe = document.createElement("span");
    probe.textContent = FIT_PROBE_TEXT;
    probe.getBoundingClientRect = () => DOMRect.fromRect({ width, height });
    return probe;
  }

  function scrollerOf(width: number, height: number, padding: string): HTMLDivElement {
    const scroller = document.createElement("div");
    scroller.style.padding = padding;
    Object.defineProperty(scroller, "clientWidth", { value: width });
    Object.defineProperty(scroller, "clientHeight", { value: height });
    document.body.append(scroller);
    return scroller;
  }

  afterEach(() => document.body.replaceChildren());

  it("answers null where there is no layout (jsdom's zero boxes)", () => {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    expect(measureMirrorGrid(scroller, probeOf(0, 0))).toBeNull();
  });

  it("measures the content box inside the scroller's padding", () => {
    // 390 × 540 client box, 8px either side and 12px at the foot: 374 × 528 of content.
    const scroller = scrollerOf(390, 540, "0px 8px 12px 8px");
    expect(measureMirrorGrid(scroller, probeOf(120, 12.5))).toEqual({ cols: 62, rows: 42 });
  });

  it("clamps what it measured into the bridge's bounds", () => {
    const scroller = scrollerOf(100, 60, "0px");
    expect(measureMirrorGrid(scroller, probeOf(120, 12.5))).toEqual({
      cols: FIT_BOUNDS.minCols,
      rows: FIT_BOUNDS.minRows,
    });
  });
});

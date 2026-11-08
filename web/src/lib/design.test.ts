import { beforeEach, describe, expect, it } from "vitest";

import { LIBRARY_STORAGE_KEY } from "@/lib/theme/store";

import {
  DEFAULT_FONT,
  DESIGN_STORAGE_KEY,
  RETIRED_THEME_ID,
  __resetDesign,
  designPrefs,
  fontClass,
  mathEngineOf,
  parseDesignPrefs,
  setDesignFont,
  setDesignMark,
  setDesignMath,
  setDesignTheme,
} from "./design";

// The device look is an object so it can grow siblings. These cases hold the newest sibling, the
// colour theme (M57), to the rule that a field this build knows is never dropped by a write to
// another one.

const stored = () => JSON.parse(localStorage.getItem(DESIGN_STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
});

describe("the theme field", () => {
  it("reads an id of the right shape and keeps it even when no such theme exists", () => {
    expect(parseDesignPrefs('{"font":"aldrich","theme":"midnight"}')).toEqual({ font: "aldrich", theme: "midnight" });
    expect(parseDesignPrefs('{"font":"aldrich","theme":"gone-tomorrow"}').theme).toBe("gone-tomorrow");
  });

  it("drops a value that is not an id, and treats collie as absence", () => {
    for (const bad of ['"Has Caps"', '"a;b"', '""', "5", "null", '"-lead"', `"${"a".repeat(33)}"`, '"collie"']) {
      expect(parseDesignPrefs(`{"font":"system","theme":${bad}}`)).toEqual({ font: "system" });
    }
  });

  it("round-trips through storage", () => {
    setDesignTheme("midnight");
    expect(stored()).toEqual({ font: "atkinson", theme: "midnight" });
    __resetDesign();
    expect(designPrefs().theme).toBe("midnight");
  });

  it("omits the field for collie, so the blob is what a device that never chose stores", () => {
    setDesignTheme("midnight");
    setDesignTheme("collie");
    expect(stored()).toEqual({ font: "atkinson" });
  });

  it("moves a stored collie-new to collie on first read, and writes the blob back", () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "atkinson", theme: RETIRED_THEME_ID }));
    __resetDesign();
    expect(designPrefs()).toEqual({ font: "atkinson" });
    expect(stored()).toEqual({ font: "atkinson" });
  });

  it("keeps the operator mirror when it moves collie-new, and leaves other ids alone", () => {
    const operatorFont = { family: "Mine", basename: "mine.woff2" };
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "op:mine.woff2", operatorFont, theme: RETIRED_THEME_ID }));
    __resetDesign();
    expect(stored()).toEqual({ font: "op:mine.woff2", operatorFont });
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "aldrich", theme: "nightwatch" }));
    __resetDesign();
    expect(stored()).toEqual({ font: "aldrich", theme: "nightwatch" });
  });

  it("does not move a collie-new that an imported theme in the library owns", () => {
    expect(LIBRARY_STORAGE_KEY).toBe("collie:themes:v1");
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, themes: [{ id: RETIRED_THEME_ID }] }));
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "aldrich", theme: RETIRED_THEME_ID }));
    __resetDesign();
    expect(designPrefs().theme).toBe(RETIRED_THEME_ID);
    expect(stored()).toEqual({ font: "aldrich", theme: RETIRED_THEME_ID });
  });

  it("ignores an id of the wrong shape", () => {
    setDesignTheme("midnight");
    setDesignTheme("Bad Id");
    expect(designPrefs().theme).toBe("midnight");
  });

  it("survives a change of face, and a change of theme keeps the face and the operator mirror", () => {
    setDesignTheme("midnight");
    setDesignFont("system");
    expect(stored()).toEqual({ font: "system", theme: "midnight" });
    setDesignFont("op:depart.woff2", { family: "Depart", basename: "depart.woff2" });
    setDesignTheme("other");
    expect(stored()).toEqual({
      font: "op:depart.woff2",
      operatorFont: { family: "Depart", basename: "depart.woff2" },
      theme: "other",
    });
  });
});

// The default face is Atkinson Hyperlegible (2026-11-06). Three kinds of device must agree with it:
// one that stored nothing, one that stored `collie` (which is the absence of the field), and one
// that chose Aldrich on purpose.
describe("the default face", () => {
  const classes = () => document.documentElement.className;

  beforeEach(() => {
    document.documentElement.className = "";
  });

  it("is Atkinson, and wears no class", () => {
    expect(DEFAULT_FONT).toBe("atkinson");
    expect(fontClass(DEFAULT_FONT)).toBe("");
    expect(fontClass("aldrich")).toBe("font-aldrich");
  });

  it("is what a device with nothing stored renders, before and after mount", () => {
    localStorage.clear();
    __resetDesign();
    expect(designPrefs().font).toBe("atkinson");
    expect(classes()).toBe("");
  });

  it("is what a device with theme collie and no font renders", () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ theme: "collie" }));
    __resetDesign();
    expect(designPrefs().font).toBe("atkinson");
    expect(classes()).toBe("");
  });

  it("keeps Aldrich for a device that stored it, and puts font-aldrich on the root", () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "aldrich" }));
    __resetDesign();
    expect(designPrefs().font).toBe("aldrich");
    expect(classes()).toBe("font-aldrich");
    setDesignFont("atkinson");
    expect(classes()).toBe("");
  });
});

describe("the math field", () => {
  it("reads an engine and treats off, or anything else, as absence", () => {
    expect(parseDesignPrefs('{"font":"aldrich","math":"katex"}')).toEqual({ font: "aldrich", math: "katex" });
    expect(parseDesignPrefs('{"font":"aldrich","math":"mathjax"}').math).toBe("mathjax");
    for (const bad of ['"off"', '"KaTeX"', '"tex"', "1", "null", "true"]) {
      expect(parseDesignPrefs(`{"font":"aldrich","math":${bad}}`)).toEqual({ font: "aldrich" });
    }
  });

  it("defaults to off on a device that never chose", () => {
    expect(mathEngineOf(designPrefs())).toBe("off");
  });

  it("round-trips through storage, and off stores what a device that never chose stores", () => {
    setDesignMath("mathjax");
    expect(stored()).toEqual({ font: "atkinson", math: "mathjax" });
    __resetDesign();
    expect(mathEngineOf(designPrefs())).toBe("mathjax");
    setDesignMath("off");
    expect(stored()).toEqual({ font: "atkinson" });
  });

  it("ignores a value that is not an engine", () => {
    setDesignMath("katex");
    setDesignMath("latex");
    expect(designPrefs().math).toBe("katex");
  });

  it("survives a change of face and of theme, and keeps both when it changes", () => {
    setDesignMath("katex");
    setDesignFont("op:depart.woff2", { family: "Depart", basename: "depart.woff2" });
    setDesignTheme("midnight");
    expect(stored()).toEqual({
      font: "op:depart.woff2",
      operatorFont: { family: "Depart", basename: "depart.woff2" },
      theme: "midnight",
      math: "katex",
    });
    setDesignMath("mathjax");
    expect(stored()).toEqual({
      font: "op:depart.woff2",
      operatorFont: { family: "Depart", basename: "depart.woff2" },
      theme: "midnight",
      math: "mathjax",
    });
  });
});

describe("the mark field", () => {
  it("reads one of the ids and treats anything else as absence", () => {
    expect(parseDesignPrefs('{"font":"aldrich","mark":"kawaii"}')).toEqual({ font: "aldrich", mark: "kawaii" });
    expect(parseDesignPrefs('{"font":"aldrich","mark":"pixel"}').mark).toBe("pixel");
    expect(parseDesignPrefs('{"font":"aldrich","mark":"kawaii-tilt"}').mark).toBe("kawaii-tilt");
    expect(parseDesignPrefs('{"font":"aldrich","mark":"collie"}').mark).toBe("collie");
    for (const bad of ['"Kawaii"', '"theme"', '""', '"dog"', "1", "null", "true", '["pixel"]']) {
      expect(parseDesignPrefs(`{"font":"aldrich","mark":${bad}}`)).toEqual({ font: "aldrich" });
    }
  });

  it("is absent on a device that never chose", () => {
    expect(designPrefs().mark).toBeUndefined();
  });

  it("round-trips through storage, and null (From the theme) stores what a device that never chose stores", () => {
    setDesignMark("pixel");
    expect(stored()).toEqual({ font: "atkinson", mark: "pixel" });
    __resetDesign();
    expect(designPrefs().mark).toBe("pixel");
    setDesignMark(null);
    expect(stored()).toEqual({ font: "atkinson" });
  });

  it("ignores a value that is not an id", () => {
    setDesignMark("kawaii");
    setDesignMark("dog");
    setDesignMark("");
    expect(designPrefs().mark).toBe("kawaii");
  });

  it("survives a change of face, theme and math, and they survive it", () => {
    setDesignMark("kawaii");
    setDesignFont("system");
    setDesignTheme("midnight");
    setDesignMath("katex");
    expect(stored()).toEqual({ font: "system", theme: "midnight", math: "katex", mark: "kawaii" });
    setDesignMark("pixel");
    expect(stored()).toEqual({ font: "system", theme: "midnight", math: "katex", mark: "pixel" });
  });

  it("is kept when a retired theme id is moved to collie on load", () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ font: "aldrich", theme: RETIRED_THEME_ID, math: "katex", mark: "pixel" }));
    __resetDesign();
    expect(stored()).toEqual({ font: "aldrich", math: "katex", mark: "pixel" });
  });
});

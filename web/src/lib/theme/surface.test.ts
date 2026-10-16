import { describe, expect, it } from "vitest";

import {
  SURFACE,
  SURFACE_DEFAULTS,
  SURFACE_INIT_LINE,
  SURFACE_INIT_MARKER,
  SURFACE_PROPERTIES,
  SURFACE_TOKENS,
  fullSurfaceDeclarations,
  resolveSurface,
  surfaceDeclarations,
  surfaceInitTable,
  surfaceWordOf,
  surfaceWords,
  withSurfaceInitLine,
} from "./surface";

// The word table, spelled out a second time on purpose. The table in surface.ts is the one source
// for the app; this copy is the reviewed design (M57 spec 14), so a change to a value in the table
// fails here and has to be made twice, by someone who meant it.

const NONE = "0 0 #0000";
const XS = "0 1px 2px 0 rgb(0 0 0 / 0.05)";
const SM = "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)";
const MD = "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)";
const LG = "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)";
const XL = "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)";
const XXL = "0 25px 50px -12px rgb(0 0 0 / 0.25)";
const XXXL = "0 32px 64px -12px rgb(0 0 0 / 0.3)";

const shadow = (values: readonly string[]) =>
  ["", "-xs", "-sm", "-md", "-lg", "-xl", "-2xl"].map((step, i) => [`--surface-shadow${step}`, values[i]]);
const radius = (values: readonly number[]) =>
  ["sm", "md", "lg", "xl"].map((step, i) => [`--radius-${step}`, `${values[i]}px`]);

const DESIGN = {
  radius: {
    sharp: radius([2, 2, 2, 2]),
    soft: radius([4, 6, 8, 12]),
    round: radius([8, 12, 16, 24]),
  },
  shadow: {
    default: shadow([SM, XS, SM, MD, LG, XL, XXL]),
    flat: shadow([NONE, NONE, NONE, NONE, NONE, NONE, NONE]),
    lifted: shadow([MD, SM, MD, LG, XL, XXL, XXXL]),
  },
  density: {
    default: [["--spacing", "0.25rem"]],
    roomy: [["--spacing", "0.28rem"]],
  },
  weight: {
    default: [
      ["--font-weight-medium", "500"],
      ["--font-weight-semibold", "600"],
    ],
    bold: [
      ["--font-weight-medium", "600"],
      ["--font-weight-semibold", "700"],
    ],
  },
  border: {
    default: [["--surface-border-width", "1px"]],
    strong: [["--surface-border-width", "2px"]],
  },
};

/** The reviewed declarations of one word, looked up by comparing names. */
function designOf(token: string, word: string): string[][] | undefined {
  const words = Object.entries(DESIGN).find(([name]) => name === token)?.[1];
  return words === undefined ? undefined : Object.entries(words).find(([name]) => name === word)?.[1];
}

describe("the shape tokens", () => {
  it("are five, in the order a file's words are applied", () => {
    expect(SURFACE_TOKENS).toEqual(["radius", "shadow", "density", "weight", "border"]);
  });

  it.each(SURFACE_TOKENS)("%s: every word sets exactly the reviewed declarations", (token) => {
    expect(JSON.parse(JSON.stringify(SURFACE[token]))).toEqual(DESIGN[token]);
  });

  it.each(SURFACE_TOKENS)("%s: the default word is listed first and is the reviewed default", (token) => {
    expect(surfaceWords(token)[0]).toBe(SURFACE_DEFAULTS[token]);
  });

  it("names today's look as the default of every token", () => {
    expect(SURFACE_DEFAULTS).toEqual({
      radius: "sharp",
      shadow: "default",
      density: "default",
      weight: "default",
      border: "default",
    });
  });

  it.each(SURFACE_TOKENS)("%s: every word sets the same properties, so a switch overwrites the last theme", (token) => {
    const sets = surfaceWords(token).map((word) => fullSurfaceDeclarations({ [token]: word }).map(([p]) => p));
    for (const set of sets) expect(set).toEqual(sets[0]);
  });

  it("lists every property any word sets, each once", () => {
    expect(SURFACE_PROPERTIES).toEqual([
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--surface-shadow",
      "--surface-shadow-xs",
      "--surface-shadow-sm",
      "--surface-shadow-md",
      "--surface-shadow-lg",
      "--surface-shadow-xl",
      "--surface-shadow-2xl",
      "--spacing",
      "--font-weight-medium",
      "--font-weight-semibold",
      "--surface-border-width",
    ]);
  });
});

describe("words", () => {
  it("finds a word by comparing, and refuses anything else", () => {
    expect(surfaceWordOf("radius", "soft")).toBe("soft");
    expect(surfaceWordOf("radius", "default")).toBeUndefined();
    expect(surfaceWordOf("density", "compact")).toBeUndefined();
    expect(surfaceWordOf("shadow", "constructor")).toBeUndefined();
    expect(surfaceWordOf("shadow", "__proto__")).toBeUndefined();
    expect(surfaceWordOf("weight", "BOLD")).toBeUndefined();
    expect(surfaceWordOf("border", undefined)).toBeUndefined();
  });

  it("fills a missing surface, or a missing token, with the default word", () => {
    expect(resolveSurface(undefined)).toEqual(SURFACE_DEFAULTS);
    expect(resolveSurface({})).toEqual(SURFACE_DEFAULTS);
    expect(resolveSurface({ density: "roomy" })).toEqual({ ...SURFACE_DEFAULTS, density: "roomy" });
  });

  it("declares only the words a surface names, in token order", () => {
    expect(surfaceDeclarations(undefined)).toEqual([]);
    expect(surfaceDeclarations({})).toEqual([]);
    expect(surfaceDeclarations({ border: "strong", density: "roomy" })).toEqual([
      ["--spacing", "0.28rem"],
      ["--surface-border-width", "2px"],
    ]);
  });

  it("declares every token for the full set, defaults included", () => {
    expect(fullSurfaceDeclarations(undefined).map(([p]) => p)).toEqual([...SURFACE_PROPERTIES]);
  });
});

describe("the line theme-init.js carries", () => {
  it("holds the whole table as arrays", () => {
    const literal = SURFACE_INIT_LINE.replace(/^ {2}var SURFACE = /, "").replace(/;$/, "");
    expect(JSON.parse(literal)).toEqual(surfaceInitTable());
    const table = surfaceInitTable();
    expect(table.map(([token]) => token)).toEqual([...SURFACE_TOKENS]);
    for (const [token, words] of table) {
      for (const [word, declarations] of words) {
        expect(declarations).toEqual(designOf(token, word));
      }
    }
  });

  it("is written after the marker, and only there", () => {
    const text = ["a", SURFACE_INIT_MARKER, "  var SURFACE = [];", "b"].join("\n");
    expect(withSurfaceInitLine(text)).toBe(["a", SURFACE_INIT_MARKER, SURFACE_INIT_LINE, "b"].join("\n"));
    expect(withSurfaceInitLine("no marker here")).toBeUndefined();
  });
});

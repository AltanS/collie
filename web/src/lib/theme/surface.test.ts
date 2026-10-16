import { describe, expect, it } from "vitest";

import {
  ANSI_KEYS,
  ANSI_PROPERTIES,
  DISPLAY_PROPERTIES,
  VERSION_TWO_PROPERTIES,
  SURFACE,
  SURFACE_DEFAULTS,
  SURFACE_INIT_LINE,
  SURFACE_INIT_MARKER,
  SURFACE_PROPERTIES,
  SURFACE_TOKENS,
  fullSurfaceDeclarations,
  resolveSurface,
  surfaceDeclarations,
  ansiDeclarations,
  ansiInitTable,
  ansiProperty,
  displayDeclarations,
  displayInitTable,
  versionTwoDeclarations,
  surfaceInitTable,
  surfaceWordOf,
  surfaceWords,
  withSurfaceInitLine,
  wordDeclarations,
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
const radius = (values: readonly number[], edge: string, edgeShadow: string) => [
  ...["sm", "md", "lg", "xl"].map((step, i) => [`--radius-${step}`, `${values[i]}px`]),
  ["--edge-accent", edge],
  ["--edge-shadow", edgeShadow],
];

const DESIGN = {
  radius: {
    sharp: radius([2, 2, 2, 2], "inset 2px 0 0 0", "0 0 #0000"),
    soft: radius([4, 6, 8, 12], "inset 0 0 0 2px", "0 1px 3px 0 rgb(0 0 0 / 0.1)"),
    round: radius([8, 12, 16, 24], "inset 0 0 0 2px", "0 1px 3px 0 rgb(0 0 0 / 0.1)"),
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
  ground: {
    flat: [["--ground-image", "none"]],
    gradient: [
      [
        "--ground-image",
        "linear-gradient(to bottom, var(--background), color-mix(in oklab, var(--background) 88%, var(--primary)))",
      ],
    ],
    grain: [
      [
        "--ground-image",
        "repeating-linear-gradient(45deg, color-mix(in oklab, var(--background) 96%, var(--foreground)) 0 1px, transparent 1px 4px), " +
          "repeating-linear-gradient(-45deg, color-mix(in oklab, var(--background) 96%, var(--foreground)) 0 1px, transparent 1px 4px)",
      ],
    ],
  },
  chrome: {
    page: [
      ["--band-ground", "var(--background)"],
      ["--band-rule", "var(--rule)"],
    ],
    band: [
      ["--band-ground", "var(--secondary)"],
      ["--band-rule", "var(--border)"],
    ],
  },
  rows: {
    rules: [
      ["--row-gap", "0px"],
      ["--row-rule", "var(--surface-border-width)"],
      ["--row-edge", "0px"],
      ["--row-corner", "0px"],
      ["--row-shadow", "none"],
      ["--row-inset", "0px"],
      ["--row-fill", "transparent"],
    ],
    cards: [
      ["--row-gap", "8px"],
      ["--row-rule", "0px"],
      ["--row-edge", "var(--surface-border-width)"],
      ["--row-corner", "var(--radius-sm)"],
      ["--row-shadow", "var(--surface-shadow-xs)"],
      ["--row-inset", "8px"],
      ["--row-fill", "var(--card)"],
    ],
  },
  icons: {
    default: [["--icon-stroke", "2"]],
    thin: [["--icon-stroke", "1.5"]],
    heavy: [["--icon-stroke", "2.5"]],
  },
  labels: {
    caps: [
      ["--label-transform", "uppercase"],
      ["--label-tracking", "0.025em"],
    ],
    sentence: [
      ["--label-transform", "none"],
      ["--label-tracking", "normal"],
    ],
  },
};

/** The reviewed declarations of one word, looked up by comparing names. */
function designOf(token: string, word: string): string[][] | undefined {
  const words = Object.entries(DESIGN).find(([name]) => name === token)?.[1];
  return words === undefined ? undefined : Object.entries(words).find(([name]) => name === word)?.[1];
}

describe("the shape tokens", () => {
  it("are ten, in the order a file's words are applied", () => {
    expect(SURFACE_TOKENS).toEqual(["radius", "shadow", "density", "weight", "border", "ground", "chrome", "rows", "icons", "labels"]);
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
      ground: "flat",
      chrome: "page",
      rows: "rules",
      icons: "default",
      labels: "caps",
    });
  });

  it.each(SURFACE_TOKENS)("%s: every word sets the same properties, so a switch overwrites the last theme", (token) => {
    const sets = surfaceWords(token).map((word) => fullSurfaceDeclarations({ [token]: word }).map(([p]) => p));
    for (const set of sets) expect(set).toEqual(sets[0]);
  });

  it("marks a row with today's left bar under sharp, and with a ring on all four sides under soft and round", () => {
    const edge = (word: "sharp" | "soft" | "round") =>
      new Map(wordDeclarations("radius", word)).get("--edge-accent");
    expect(edge("sharp")).toBe("inset 2px 0 0 0");
    expect(edge("soft")).toBe("inset 0 0 0 2px");
    expect(edge("round")).toBe("inset 0 0 0 2px");
    const soft = (word: "sharp" | "soft" | "round") =>
      new Map(wordDeclarations("radius", word)).get("--edge-shadow");
    expect(soft("sharp")).toBe("0 0 #0000");
    expect(soft("soft")).toBe("0 1px 3px 0 rgb(0 0 0 / 0.1)");
    expect(soft("round")).toBe("0 1px 3px 0 rgb(0 0 0 / 0.1)");
  });

  it("lists every property any word sets, each once", () => {
    expect(SURFACE_PROPERTIES).toEqual([
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--edge-accent",
      "--edge-shadow",
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
      "--ground-image",
      "--band-ground",
      "--band-rule",
      "--row-gap",
      "--row-rule",
      "--row-edge",
      "--row-corner",
      "--row-shadow",
      "--row-inset",
      "--row-fill",
      "--icon-stroke",
      "--label-transform",
      "--label-tracking",
    ]);
  });

  // Cards never pair a left accent with rounded corners (DESIGN.md §13, the lead's condition 4). A
  // card row takes the group's own `--radius-sm`, and the radius word decides the marked-row edge
  // with it: under sharp (2px, square) the left bar, under soft and round the ring.
  it("gives a card row the radius word's corner, so a left bar only ever meets square corners", () => {
    expect(new Map(wordDeclarations("rows", "cards")).get("--row-corner")).toBe("var(--radius-sm)");
    for (const word of ["soft", "round"] as const) {
      const declared = new Map(wordDeclarations("radius", word));
      expect(declared.get("--edge-accent")).not.toBe("inset 2px 0 0 0");
    }
    expect(new Map(wordDeclarations("radius", "sharp")).get("--radius-sm")).toBe("2px");
  });
});

describe("the display face and the terminal palette", () => {
  it("points the display face at its stack in index.css, one per shipped face", () => {
    expect(displayDeclarations("geist")).toEqual([["--font-display", "var(--face-geist)"]]);
    expect(displayInitTable().map(([face]) => face)).toEqual(["system", "grotesk", "aldrich", "plex", "geist", "atkinson"]);
    expect(DISPLAY_PROPERTIES).toEqual(["--font-display"]);
  });

  it("maps the eighteen palette keys to the mirror's properties", () => {
    expect(ANSI_KEYS).toHaveLength(18);
    expect(ansiProperty("0")).toBe("--ansi-0");
    expect(ansiProperty("15")).toBe("--ansi-15");
    expect(ansiProperty("ink")).toBe("--mirror-ink");
    expect(ansiProperty("ground")).toBe("--mirror-ground");
    expect(ANSI_PROPERTIES).toEqual([...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`), "--mirror-ink", "--mirror-ground"]);
    expect(ansiInitTable()).toEqual(ANSI_KEYS.map((k) => [k, ansiProperty(k)]));
    expect(ansiDeclarations(undefined)).toEqual([]);
  });

  it("sets the words, then the display face, then the palette, and nothing a theme leaves out", () => {
    const ansi = {
      "0": "#123456", "1": "#123456", "2": "#123456", "3": "#123456", "4": "#123456", "5": "#123456",
      "6": "#123456", "7": "#123456", "8": "#123456", "9": "#123456", "10": "#123456", "11": "#123456",
      "12": "#123456", "13": "#123456", "14": "#123456", "15": "#123456", ink: "#123456", ground: "#123456",
    };
    expect(versionTwoDeclarations({})).toEqual([]);
    expect(versionTwoDeclarations({ fonts: { display: "plex" } })).toEqual([["--font-display", "var(--face-plex)"]]);
    expect(versionTwoDeclarations({ fonts: { display: "comic-sans" } })).toEqual([]);
    const all = versionTwoDeclarations({ surface: { icons: "thin" }, fonts: { display: "plex" }, ansi });
    expect(all.map(([p]) => p)).toEqual(["--icon-stroke", "--font-display", ...ANSI_PROPERTIES]);
    expect(VERSION_TWO_PROPERTIES).toEqual([...SURFACE_PROPERTIES, ...DISPLAY_PROPERTIES, ...ANSI_PROPERTIES]);
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
    const parts = /^ {2}var SURFACE = (.*), DISPLAY = (.*), ANSI = (.*);$/.exec(SURFACE_INIT_LINE);
    expect(JSON.parse(parts?.[1] ?? "")).toEqual(surfaceInitTable());
    expect(JSON.parse(parts?.[2] ?? "")).toEqual(displayInitTable());
    expect(JSON.parse(parts?.[3] ?? "")).toEqual(ansiInitTable());
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

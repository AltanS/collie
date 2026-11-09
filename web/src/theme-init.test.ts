import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DESIGN_STORAGE_KEY } from "@/lib/design";
import type { JsonObject } from "@/lib/json";
import { THEME_ESCAPE_SOURCE } from "@/lib/theme/escape";
import { ALL_THEME_TOKENS, COLOUR_MAX, COLOUR_SOURCE, SHIPPED_THEME_IDS, THEME_TOKENS, isColour, parseTheme, type Theme } from "@/lib/theme/schema";
import { LIBRARY_STORAGE_KEY, applyTheme } from "@/lib/theme/store";
import {
  ANSI_KEYS,
  VERSION_TWO_PROPERTIES,
  SURFACE_INIT_LINE,
  SURFACE_INIT_MARKER,
  SURFACE_PROPERTIES,
  SURFACE_TOKENS,
  groundDeclarations,
  groundWords,
  surfaceWords,
  wordDeclarations,
  withSurfaceInitLine,
} from "@/lib/theme/surface";

// public/theme-init.js runs before the module graph exists, so it spells the facts the colour theme
// needs: the shipped ids, the closed token list, the colour pattern and the two storage keys. Only a
// test that reads both files can stop them drifting, and the drift is silent: the app keeps working
// and the first frame is simply painted in the wrong colours. Reads the file from disk, like
// fonts.test.ts does for the face.

const init = readFileSync(resolve(import.meta.dirname, "../public/theme-init.js"), "utf8");

/** The quoted strings of `var NAME = [ ... ];`. */
function listOf(name: string): string[] {
  const body = new RegExp(`var ${name} = \\[([^\\]]*)\\];`).exec(init)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("theme-init.js and lib/theme agree", () => {
  it("names the shipped themes that wear an attribute, and not collie", () => {
    expect(listOf("SHIPPED")).toEqual(SHIPPED_THEME_IDS.filter((id) => id !== "collie"));
  });

  it("spells the closed token list, all of it and in order, the optional tokens last", () => {
    expect(listOf("TOKENS")).toEqual([...ALL_THEME_TOKENS]);
    expect(listOf("TOKENS").slice(0, 43)).toEqual([...THEME_TOKENS]);
    expect(listOf("TOKENS")).toHaveLength(45);
  });

  it("holds the same colour pattern and the same length cap", () => {
    expect(init).toContain(`/${THEME_ESCAPE_SOURCE}/.test(location.hash)`);
    const literal = /var COLOUR = \/(.*)\/;/.exec(init)?.[1];
    expect(literal).toBe(new RegExp(COLOUR_SOURCE).source);
    expect(init).toContain(`v.length <= ${COLOUR_MAX}`);
  });

  it("reads the same two storage keys", () => {
    expect(DESIGN_STORAGE_KEY).toBe("collie:design:v1");
    expect(LIBRARY_STORAGE_KEY).toBe("collie:themes:v1");
    expect(init).toContain(`localStorage.getItem("${DESIGN_STORAGE_KEY}")`);
    expect(init).toContain(`localStorage.getItem("${LIBRARY_STORAGE_KEY}")`);
  });

  it("reads the theme from the design blob's `theme` field, and the library as version 1", () => {
    expect(init).toContain("applyColourTheme(d.theme)");
    expect(init).toContain("lib.version === 1");
  });

  it("takes the property name from its own list and the attribute value from its own list", () => {
    expect(init).toContain('root.style.setProperty("--" + TOKENS[k]');
    expect(init).toContain('root.setAttribute("data-theme", SHIPPED[i])');
    // Nothing of the stored object's own keys or ids reaches a sink: no loop over its keys.
    expect(init).not.toMatch(/for \(var \w+ in /);
    expect(init).not.toContain("Object.keys");
  });

  it("only adds: it removes no class, attribute or property", () => {
    expect(init).not.toMatch(/removeProperty|removeAttribute|classList\.remove/);
  });

  it("adds fewer than 64 lines for the theme job", () => {
    const lines = init.split("\n");
    const start = lines.findIndex((l) => l.includes("IT NOW DOES A THIRD THING")) - 1;
    const fn = lines.findIndex((l) => l.startsWith("  function applyColourTheme"));
    const end = lines.findIndex((l, i) => i > fn && l === "  }");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(fn);
    // The block, the one call site, and the hand-off line that was not there before. Four more lines
    // since the default theme paints Collie's grain from :root: an imported theme names its own ground
    // or says `flat`, so the budget moved from 60 to 64. Two more since the ground may be an object
    // of four words (schema version 4): one line reads it, one applies its four small tables.
    expect(end - start + 1 + 1).toBeLessThan(66);
  });
});

describe("the colour pattern theme-init.js uses", () => {
  const pre = new RegExp(COLOUR_SOURCE);

  it("accepts what the parser accepts, in the parser's own spelling", () => {
    for (const value of ["#0a0a0a", "#0a0a0a80", "oklch(0.97 0 0)", "oklch(0.5 0.1 120 / 0.5)", "oklch(0.5 0.1 120 / 50%)", "oklch(.5 .1 120)"]) {
      expect(isColour(value), value).toBe(true);
      expect(pre.test(value), value).toBe(true);
    }
  });

  it("refuses every shape the parser refuses", () => {
    for (const value of [
      "red",
      "#fff",
      "#GGGGGG",
      "rgb(0 0 0)",
      "var(--x)",
      "url(https://x.test/a.png)",
      "#000000; color: red",
      "#000000}",
      "oklch(0.5 0.1 120) !important",
      "oklch(0.5 0.1 120 / )",
      "light-dark(#000000, #ffffff)",
      "",
    ]) {
      expect(isColour(value), value).toBe(false);
      expect(pre.test(value), value).toBe(false);
    }
  });
});

// RUNNING THE SCRIPT, not reading it. The cases above hold the lists equal; these run the file
// against a stand-in document and a stand-in localStorage and look at what it wrote. It is the only
// way to cover a branch like `lib.version === 1`, which no text comparison exercises.
function runInit(store: Record<string, string>, hash = "") {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const root = {
    classList: { add: (c: string) => void classes.add(c) },
    setAttribute: (k: string, v: string) => void attributes.set(k, v),
    style: { setProperty: (k: string, v: string) => void properties.set(k, v) },
  };
  const storage = { getItem: (k: string) => store[k] ?? null };
  new Function("document", "localStorage", "location", init)({ documentElement: root }, storage, { hash });
  return { classes: [...classes], attributes: [...attributes], properties: [...properties] };
}

/** A text token: kept readable on the stand-in ground, or the parser refuses the theme (F3). */
const textToken = (token: string): boolean => token === "foreground" || token.endsWith("-foreground");

/** The theme the stand-in library holds, as the store's type. */
const midnightTheme = (): Theme => ({
  version: 1,
  id: "midnight",
  name: "Midnight",
  light: Object.fromEntries(THEME_TOKENS.map((t) => [t, textToken(t) ? "#1a1a1a" : "#ffffff"])),
  dark: Object.fromEntries(THEME_TOKENS.map((t) => [t, textToken(t) ? "#f0f0f0" : "#123456"])),
});

const midnight = (version: number) => ({
  version,
  themes: [
    {
      version: 1,
      id: "midnight",
      name: "Midnight",
      light: Object.fromEntries(THEME_TOKENS.map((t) => [t, textToken(t) ? "#1a1a1a" : "#ffffff"])),
      dark: Object.fromEntries(THEME_TOKENS.map((t) => [t, textToken(t) ? "#f0f0f0" : "#123456"])),
    },
  ],
});

// The default face is Atkinson Hyperlegible (2026-11-06): no class. Aldrich is a choice and wears
// `font-aldrich`. A blob with no font, or with only `theme: collie`, is a fresh device.
describe("theme-init.js, the default face", () => {
  it("adds no face class for nothing stored", () => {
    expect(runInit({}).classes).toEqual([]);
  });

  it("adds no face class for a blob with no font, or a stored collie and no font", () => {
    expect(runInit({ "collie:design:v1": JSON.stringify({}) }).classes).toEqual([]);
    expect(runInit({ "collie:design:v1": JSON.stringify({ theme: "collie" }) }).classes).toEqual([]);
  });

  it("adds no face class for a stored atkinson", () => {
    expect(runInit({ "collie:design:v1": JSON.stringify({ font: "atkinson" }) }).classes).toEqual([]);
  });

  it("adds font-nunito for a stored nunito", () => {
    expect(runInit({ "collie:design:v1": JSON.stringify({ font: "nunito" }) }).classes).toEqual(["font-nunito"]);
  });

  it("keeps Aldrich for a device that stored it", () => {
    expect(runInit({ "collie:design:v1": JSON.stringify({ font: "aldrich" }) }).classes).toEqual(["font-aldrich"]);
  });
});

describe("theme-init.js, run", () => {
  it("applies an imported theme from a version 1 library", () => {
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ theme: "midnight" }),
      "collie:themes:v1": JSON.stringify(midnight(1)),
    });
    // The colour tokens, and `--ground-image: none`: a theme that names no ground must not inherit :root's grain.
    expect(seen.properties).toHaveLength(THEME_TOKENS.length + 1);
    expect(seen.properties).toContainEqual([GROUND, "none"]);
  });

  it("paints the default's grain through index.css alone: the script sets nothing for collie or for a blob-less device", () => {
    expect(runInit({ "collie:design:v1": JSON.stringify({ theme: "collie" }) }).properties).toEqual([]);
    expect(runInit({}).properties).toEqual([]);
    const sheet = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");
    const grain = wordDeclarations("ground", "grain")[0]?.[1] ?? "";
    expect(sheet).toContain(`--ground-image: ${grain};`);
  });

  it("paints nothing from a library entry that claims the id collie (F12)", () => {
    const entry = { ...midnight(1).themes[0], id: "collie" };
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ theme: "collie" }),
      "collie:themes:v1": JSON.stringify({ version: 1, themes: [entry] }),
    });
    expect(seen).toEqual({ classes: [], attributes: [], properties: [] });
  });

  it("paints a stored collie-new as the default: no attribute and no property", () => {
    const seen = runInit({ "collie:design:v1": JSON.stringify({ font: "atkinson", theme: "collie-new" }) });
    expect(seen).toEqual({ classes: [], attributes: [], properties: [] });
  });

  it("still applies an imported theme whose id is collie-new", () => {
    const entry = { ...midnight(1).themes[0], id: "collie-new" };
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ theme: "collie-new" }),
      "collie:themes:v1": JSON.stringify({ version: 1, themes: [entry] }),
    });
    expect(seen.attributes).toEqual([]);
    // The colour tokens, and `--ground-image: none`: a theme that names no ground must not inherit :root's grain.
    expect(seen.properties).toHaveLength(THEME_TOKENS.length + 1);
    expect(seen.properties).toContainEqual([GROUND, "none"]);
  });

  it("paints Collie under #theme=collie, the way back from any theme, and keeps the face", () => {
    const store = {
      "collie:design:v1": JSON.stringify({ font: "aldrich", theme: "midnight" }),
      "collie:themes:v1": JSON.stringify(midnight(1)),
    };
    expect(runInit(store, "#theme=collie")).toEqual({ classes: ["font-aldrich"], attributes: [], properties: [] });
    expect(runInit(store, "#a=1&theme=collie").properties).toEqual([]);
    expect(runInit({ "collie:design:v1": JSON.stringify({ theme: "nightwatch" }) }, "#theme=collie").attributes).toEqual([]);
    // Only that word: another theme name, or a longer value, is not the escape.
    expect(runInit(store, "#theme=collies").properties).not.toEqual([]);
    expect(runInit(store, "#theme=nightwatch").properties).not.toEqual([]);
  });

  it("applies nothing from a library that says version 2", () => {
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ theme: "midnight" }),
      "collie:themes:v1": JSON.stringify(midnight(2)),
    });
    expect(seen).toEqual({ classes: [], attributes: [], properties: [] });
  });

  it("gives a pre-M57 design blob with no theme and a dark pin the dark class and nothing else", () => {
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ font: "atkinson" }),
      "collie:theme:v1": "dark",
    });
    expect(seen.classes).toEqual(["dark"]);
    expect(seen.attributes).toEqual([]);
    expect(seen.properties).toEqual([]);
  });
});

// ── The shape words, schema version 2 (M57 spec 14) ───────────────────────────────────────────────
//
// theme-init.js carries the word table as one generated line. These cases hold the line equal to what
// surface.ts writes, and then RUN the script and the store over the same theme for every word of every
// token: the declarations the first frame gets must be the ones the app sets a moment later.

/** A version 2 library entry: collie-like colours and the given surface block. */
function libraryWithSurface(surface: JsonObject) {
  const theme = midnight(1).themes[0];
  return { version: 1, themes: [{ ...theme, version: 2, surface }] };
}

/** The property the omitted-ground fill sets; the helpers below leave it out unless a theme names a ground. */
const GROUND = "--ground-image";

function initSurface(surface: JsonObject): Array<[string, string]> {
  const seen = runInit({
    "collie:design:v1": JSON.stringify({ theme: "midnight" }),
    "collie:themes:v1": JSON.stringify(libraryWithSurface(surface)),
  });
  return seen.properties.filter(([property]) => SURFACE_PROPERTIES.includes(property) && (property !== GROUND || "ground" in surface));
}

function storeSurface(theme: Theme): Array<[string, string]> {
  const root = document.documentElement;
  root.removeAttribute("style");
  applyTheme(theme, "imported");
  const out: Array<[string, string]> = [];
  for (const property of SURFACE_PROPERTIES) {
    const value = root.style.getPropertyValue(property);
    if (property === GROUND && theme.surface?.ground === undefined) continue;
    if (value !== "") out.push([property, value]);
  }
  root.removeAttribute("style");
  return out;
}

describe("theme-init.js and lib/theme/surface.ts agree", () => {
  it("carries the SURFACE line surface.ts writes, after the marker", () => {
    expect(init.split("\n")).toContain(SURFACE_INIT_MARKER);
    expect(init.split("\n")).toContain(SURFACE_INIT_LINE);
    expect(withSurfaceInitLine(init)).toBe(init);
  });

  it("takes the property names and values from its table, never from the stored object", () => {
    expect(init).toContain("root.style.setProperty(decl[x][0], decl[x][1])");
    expect(init).toContain("if (s[SURFACE[n][0]] === SURFACE[n][1][w][0]) set(SURFACE[n][1][w][1]);");
    expect(init).toContain("if (f.display === DISPLAY[m][0]) set(DISPLAY[m][1]);");
    expect(init).toContain("if (all) for (var r = 0; r < ANSI.length; r++) root.style.setProperty(ANSI[r][1], a[ANSI[r][0]]);");
  });

  it.each(SURFACE_TOKENS.flatMap((token) => surfaceWords(token).map((word) => [token, word] as const)))(
    "sets the same declarations as the store for %s: %s",
    (token, word) => {
      const fromInit = initSurface({ [token]: word });
      const theme = { ...midnightTheme(), version: 2 as const, surface: { [token]: word } };
      expect(fromInit).toEqual(storeSurface(theme));
      expect(fromInit).toEqual(wordDeclarations(token, word).map(([p, v]) => [p, v]));
    },
  );

  it("sets the same declarations as the store for a block that names every token", () => {
    const surface = {
      radius: "round",
      shadow: "lifted",
      density: "roomy",
      weight: "bold",
      border: "strong",
      ground: "grain",
      chrome: "band",
      rows: "cards",
      icons: "heavy",
      labels: "sentence",
    } as const;
    // The script sets the ground after the other tokens; no property is set twice, so the order of
    // the list does not change what the page draws.
    const byProperty = (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]);
    expect(initSurface(surface).toSorted(byProperty)).toEqual(storeSurface({ ...midnightTheme(), version: 2, surface }).toSorted(byProperty));
    expect(initSurface(surface)).toHaveLength(SURFACE_PROPERTIES.length);
  });

  // The object form of the ground (version 4): every pattern at every size and strength, in both inks,
  // and the object with keys left out. The first frame sets what the store sets a moment later.
  const GROUND_CASES: JsonObject[] = [
    {},
    { size: "wide" },
    { ink: "primary" },
    ...groundWords("pattern").flatMap((pattern) =>
      groundWords("size").flatMap((size) =>
        groundWords("strength").flatMap((strength) => groundWords("ink").map((ink) => ({ pattern, size, strength, ink }))),
      ),
    ),
  ];
  it.each(GROUND_CASES.map((ground) => [JSON.stringify(ground), ground] as const))("sets the store's declarations for the ground %s", (_, ground) => {
    const surface = { ground };
    const fromInit = initSurface(surface);
    const parsed = parseTheme(JSON.stringify({ ...midnightTheme(), version: 4, surface }), { maxBytes: 64 * 1024 });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    const fromStore = storeSurface(parsed.theme);
    const byProperty = (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]);
    expect(fromInit.toSorted(byProperty)).toEqual(fromStore.toSorted(byProperty));
    expect(new Map(fromInit)).toEqual(new Map(groundDeclarations(parsed.theme.surface?.ground)));
  });

  it("sets nothing from a ground key or word outside the table, and a word ground is its pattern", () => {
    const flat = new Map(groundDeclarations("flat"));
    for (const ground of [{ pattern: "constructor" }, { pattern: "__proto__" }, { size: "toString" }, { pattern: ["dots"] }]) {
      expect(new Map(initSurface({ ground })), JSON.stringify(ground)).toEqual(flat);
    }
    expect(new Map(initSurface({ ground: { pattern: "grain" } }))).toEqual(new Map(initSurface({ ground: "grain" })));
  });

  it("sets nothing for a word or a block outside the table", () => {
    for (const surface of [
      { radius: "constructor" },
      { radius: "__proto__" },
      { radius: "toString" },
      { radius: 8 },
      { radius: ["soft"] },
      { radius: "Soft" },
      { spacing: "roomy" },
      { "--spacing": "9rem" },
    ]) {
      expect(initSurface(surface), JSON.stringify(surface)).toEqual([]);
    }
    expect(initSurface({})).toEqual([]);
  });

  it("sets only a flat ground for a theme with no surface, so a version 1 theme paints as before", () => {
    const seen = runInit({
      "collie:design:v1": JSON.stringify({ theme: "midnight" }),
      "collie:themes:v1": JSON.stringify(midnight(1)),
    });
    // The colour tokens, and `--ground-image: none`: a theme that names no ground must not inherit :root's grain.
    expect(seen.properties).toHaveLength(THEME_TOKENS.length + 1);
    expect(seen.properties).toContainEqual([GROUND, "none"]);
  });
});

// ── The display face and the palette (M57 spec 17) ────────────────────────────────────────────────

/** A dark-space palette that passes the gate: Collie's own index.css palette on its own ground. */
const PALETTE = {
  "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510", "4": "#2472c8", "5": "#bc3fbc",
  "6": "#11a8cd", "7": "#e5e5e5", "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
  "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff", ink: "#fafafa", ground: "#0a0a0a",
} as const;

function initVersionTwo(extra: JsonObject): Array<[string, string]> {
  const theme = midnight(1).themes[0];
  const seen = runInit({
    "collie:design:v1": JSON.stringify({ theme: "midnight" }),
    "collie:themes:v1": JSON.stringify({ version: 1, themes: [{ ...theme, version: 2, ...extra }] }),
  });
  return seen.properties.filter(([property]) => VERSION_TWO_PROPERTIES.includes(property) && (property !== GROUND || extra.surface !== undefined));
}

function storeVersionTwo(theme: Theme): Array<[string, string]> {
  const root = document.documentElement;
  root.removeAttribute("style");
  applyTheme(theme, "imported");
  const out: Array<[string, string]> = [];
  for (const property of VERSION_TWO_PROPERTIES) {
    const value = root.style.getPropertyValue(property);
    if (property === GROUND && theme.surface?.ground === undefined) continue;
    if (value !== "") out.push([property, value]);
  }
  root.removeAttribute("style");
  return out;
}

describe("theme-init.js sets the display face and the palette as the store does", () => {
  it.each(["system", "grotesk", "aldrich", "plex", "geist", "atkinson", "nunito"])("display face %s", (face) => {
    const fromInit = initVersionTwo({ fonts: { display: face } });
    expect(fromInit).toEqual([["--font-display", `var(--face-${face})`]]);
    expect(fromInit).toEqual(storeVersionTwo({ ...midnightTheme(), version: 2, fonts: { display: face } }));
  });

  it("sets all eighteen palette properties for a whole palette, the same as the store", () => {
    const fromInit = initVersionTwo({ ansi: PALETTE });
    expect(fromInit).toHaveLength(ANSI_KEYS.length);
    expect(fromInit).toEqual(storeVersionTwo({ ...midnightTheme(), version: 2, ansi: PALETTE }));
    expect(new Map(fromInit).get("--mirror-ground")).toBe("#0a0a0a");
    expect(new Map(fromInit).get("--ansi-11")).toBe("#f5f543");
  });

  it("sets nothing for a face or a palette outside the tables", () => {
    const partial = Object.fromEntries(Object.entries(PALETTE).filter(([key]) => key !== "ground"));
    for (const extra of [
      { fonts: { display: "comic" } },
      { fonts: { display: "constructor" } },
      { fonts: { display: ["geist"] } },
      { ansi: partial },
      { ansi: { ...PALETTE, "3": "red" } },
      { ansi: { ...PALETTE, ground: "#0a0a0a; color: red" } },
      { ansi: "#000000" },
    ]) {
      expect(initVersionTwo(extra), JSON.stringify(extra)).toEqual([]);
    }
  });
});

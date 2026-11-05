import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHIPPED_FONTS } from "@/lib/design";
import { ALL_THEME_TOKENS, OPTIONAL_THEME_TOKENS, SHIPPED_THEME_IDS, THEME_TOKENS, contrast, contrastReport, parseTheme, type Theme } from "@/lib/theme/schema";
import { SHIPPED_FONTS as FACES } from "@/lib/shipped-fonts";
import { SURFACE_DEFAULTS, SURFACE_TOKENS, ansiDeclarations, displayDeclarations, fullSurfaceDeclarations, wordDeclarations } from "@/lib/theme/surface";
import { buildThemesCss } from "@/lib/theme/themes-css";

// The default theme is data now, and the stylesheet is still the thing that paints it. These tests
// keep the two from drifting, and keep the generated themes.css from going stale.

const web = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(web, p), "utf8");
const css = read("src/index.css");

/** Collapse runs of whitespace, so a pair written over several lines compares as one line. */
const flat = (value: string) => value.replaceAll(/\s+/g, " ").replace("( ", "(").replace(" )", ")").trim();

/**
 * The `light-dark()` tokens of index.css's `:root` block, in order. Comments are cut first, and the
 * pattern spans newlines: `--control-on-foreground` and `--destructive` are written over three.
 */
function rootTokens(): Array<{ token: string; light: string; dark: string }> {
  const start = css.indexOf("\n:root {\n");
  const end = css.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//g, "");
  return [...block.matchAll(/--([a-z0-9-]+):\s*light-dark\(\s*([^,]+?)\s*,\s*([\s\S]+?)\s*\);/g)].map((m) => ({
    token: m[1] ?? "",
    light: flat(m[2] ?? ""),
    dark: flat(m[3] ?? ""),
  }));
}

function shipped(id: string): Theme {
  const result = parseTheme(read(`src/themes/${id}.json`), { maxBytes: 64 * 1024, allowReservedId: true });
  if (!result.ok) throw new Error(result.refusals.map((r) => `${r.path}: ${r.detail}`).join("\n"));
  return result.theme;
}

/** The token a theme may leave out (schema version 3): index.css's pair holds when it does. */
const OPTIONAL: ReadonlySet<string> = new Set(OPTIONAL_THEME_TOKENS);

/** The surface words that set no CSS property: the app reads them itself. */
const APP_READ_WORDS: ReadonlySet<string> = new Set(["zoom", "tabs", "composer"]);

describe("the theme collie equals index.css", () => {
  const tokens = rootTokens();
  const collie = shipped("collie");

  it("finds all 43 tokens in index.css, in the order of the token list, and the optional one", () => {
    expect(tokens.map((t) => t.token).filter((t) => !OPTIONAL.has(t))).toEqual([...THEME_TOKENS]);
    expect(tokens.map((t) => t.token).filter((t) => OPTIONAL.has(t)).toSorted()).toEqual([...OPTIONAL_THEME_TOKENS].toSorted());
  });

  it("reads the multi-line pairs whole", () => {
    const byName = new Map(tokens.map((t) => [t.token, t]));
    expect(byName.get("control-on-foreground")).toEqual({
      token: "control-on-foreground",
      light: "oklch(0.32 0.12 245)",
      dark: "oklch(0.92 0.06 235)",
    });
    expect(byName.get("destructive")?.dark).toBe("oklch(0.72 0.19 22)");
    expect(byName.get("border")?.dark).toBe("oklch(0.42 0.003 80)");
  });

  it("holds every token of both halves, string for string", () => {
    const byName = new Map(tokens.map((t) => [t.token, t]));
    for (const token of ALL_THEME_TOKENS) {
      const row = byName.get(token);
      expect({ token, light: collie.light?.[token] }).toEqual({ token, light: row?.light });
      expect({ token, dark: collie.dark?.[token] }).toEqual({ token, dark: row?.dark });
    }
    expect(Object.keys(collie.light ?? {})).toHaveLength(ALL_THEME_TOKENS.length);
    expect(Object.keys(collie.dark ?? {})).toHaveLength(ALL_THEME_TOKENS.length);
  });

  it("carries Atkinson for the text, Aldrich for the titles and the shipped author", () => {
    expect(collie.fonts).toEqual({ ui: "atkinson", display: "aldrich" });
    expect(collie.author).toBe("Collie");
    expect(SHIPPED_FONTS).toContain("atkinson");
    expect(SHIPPED_FONTS).toContain("aldrich");
  });

  // The theme collie writes nothing on the page, so its shape, display face and palette must be what
  // index.css declares. A word that sets no property (zoom, tabs, composer) has nothing to compare.
  it("names the shape words, the display face and the palette that index.css declares", () => {
    const root = rootDeclarations();
    for (const token of SURFACE_TOKENS) {
      if (APP_READ_WORDS.has(token)) continue;
      expect(collie.surface?.[token], token).toBe(SURFACE_DEFAULTS[token]);
    }
    // Where the page reads a property from: :root, else the @theme block (radius), else Tailwind's own theme (spacing).
    for (const [property, value] of fullSurfaceDeclarations(SURFACE_DEFAULTS)) {
      expect(root.get(property) ?? themeBlock("@theme {").get(property) ?? tailwind(property), property).toBe(value);
    }
    expect(collie.surface?.tabs).toBe("folder");
    expect(collie.surface?.composer).toBe("box");
    expect(collie.fonts?.display).toBe("aldrich");
    expect(root.get("--font-display")).toBe("var(--face-aldrich)");
    for (const [property, value] of ansiDeclarations(collie.ansi)) expect(root.get(property), property).toBe(value);
    expect(Object.keys(collie.ansi ?? {})).toHaveLength(18);
  });

  // The collie theme passes every check of the report. The old default's dark `destructive-foreground`
  // (near white) on dark `destructive` (a light red) was 2.77:1, the one known failure; this look
  // pairs a dark ink with the light red (6.83) and carries no failure.
  it("passes every check of the contrast report in both halves", () => {
    expect(contrastReport(collie, collie).filter((f) => !f.pass)).toEqual([]);
  });
});

// The gate for every shipped theme other than collie (M57 spec 06). A shipped theme is complete:
// both halves, all 43 tokens, no fill from the default, and every finding of the contrast report
// passes. Unlike collie, it has no recorded failure to carry.
describe("the shipped themes", () => {
  const ids = readdirSync(resolve(web, "src/themes"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => id !== "collie")
    .toSorted();
  const collie = shipped("collie");

  it("are shipped ids, each named after its file", () => {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(SHIPPED_THEME_IDS).toContain(id);
      expect(shipped(id).id).toBe(id);
    }
  });

  it.each(ids)("%s has both halves, all 43 tokens each, a shipped face and the shipped author", (id) => {
    const theme = shipped(id);
    // The 43 are required; an optional token is present only where the theme's palette needs its own.
    expect(Object.keys(theme.light ?? {}).filter((t) => !OPTIONAL.has(t)).toSorted()).toEqual([...THEME_TOKENS].toSorted());
    expect(Object.keys(theme.dark ?? {}).filter((t) => !OPTIONAL.has(t)).toSorted()).toEqual([...THEME_TOKENS].toSorted());
    expect(SHIPPED_FONTS).toContain(theme.fonts?.ui);
    expect(theme.author).toBe("Collie");
  });

  it.each(ids)("%s is version 2 or 3 and names a word for every shape token, so an export shows the whole shape", (id) => {
    const theme = shipped(id);
    expect(theme.version).toBeGreaterThanOrEqual(2);
    // `zoom`, `tabs` and `composer` are the words that set no style (lib/zoom-pill.ts, lib/tab-look.ts,
    // lib/composer-layout.ts): a shipped theme names one only when it wants the app to draw it.
    const named = Object.keys(theme.surface ?? {}).filter((token) => !APP_READ_WORDS.has(token));
    expect(named.toSorted()).toEqual(SURFACE_TOKENS.filter((token) => !APP_READ_WORDS.has(token)).toSorted());
  });

  // M57 spec 18: each shipped theme uses the whole version 2 sheet, so it reads as another app and
  // not as a recolour. Every one names a display face and a terminal palette, at least four surface
  // words that are not the default, and no two share the same shape.
  it.each(ids)("%s names a display face, a terminal palette and four or more surface words beside the default", (id) => {
    const theme = shipped(id);
    expect(theme.fonts?.display, "fonts.display").toBeDefined();
    expect(theme.ansi, "ansi").toBeDefined();
    const moved = SURFACE_TOKENS.filter((token) => theme.surface?.[token] !== SURFACE_DEFAULTS[token]);
    expect(moved.length, moved.join(", ")).toBeGreaterThanOrEqual(4);
  });

  it("gives every shipped theme its own shape, display face and terminal ground", () => {
    const themes = ["collie", ...ids].map(shipped);
    const wordSets = themes.map((t) => SURFACE_TOKENS.map((token) => t.surface?.[token]).join(" "));
    expect(new Set(wordSets).size).toBe(themes.length);
    expect(new Set(themes.map((t) => t.fonts?.display)).size).toBe(themes.length);
    expect(new Set(themes.map((t) => t.ansi?.ground)).size).toBe(themes.length);
  });

  it.each(ids)("%s passes every check of the contrast report in both halves", (id) => {
    const report = contrastReport(shipped(id), collie);
    expect(report.filter((f) => !f.pass)).toEqual([]);
    expect(new Set(report.map((f) => f.half))).toEqual(new Set(["light", "dark"]));
  });
});

// Daylight is for direct sun and low vision, so it holds floors above the shared gate. Each number
// is argued in daylight.notes.md, beside the measured table.
describe("daylight holds its own floors", () => {
  const theme = shipped("daylight");
  const report = contrastReport(theme, shipped("collie"));
  const find = (half: "light" | "dark", check: string) => report.find((f) => f.half === half && f.check === check)?.ratio ?? 0;

  it.each(["light", "dark"] as const)("%s: body text is AAA, 7:1 or better, on the page, on a card and at the foot of the gradient", (half) => {
    expect(theme.surface?.ground).toBe("gradient");
    for (const check of [
      "foreground on background",
      "foreground on card",
      "muted-foreground on background",
      "muted-foreground on card",
      "foreground on the gradient ground",
      "muted-foreground on the gradient ground",
    ]) {
      expect(find(half, check), check).toBeGreaterThanOrEqual(7);
    }
  });

  it.each(["light", "dark"] as const)("%s: blocked and done sit 0.25 or more apart in oklab", (half) => {
    expect(find(half, "status-blocked apart from status-done")).toBeGreaterThanOrEqual(0.25);
  });

  // A step stronger than the first Collie look on both lines, and rule still the stronger of the two.
  // That look is pinned here as literals: the theme "Collie" took Collie New's lines in 2026-11, which
  // are stronger than these, and daylight was measured against the look it was drawn beside.
  const OLD_DEFAULT = {
    light: { background: "oklch(0.97 0 0)", border: "oklch(0.922 0 0)", rule: "oklch(0.875 0 0)" },
    dark: { background: "oklch(0.145 0 0)", border: "oklch(1 0 0 / 12%)", rule: "oklch(1 0 0 / 24%)" },
  } as const;
  it.each(["light", "dark"] as const)("%s: border and rule are stronger than the first Collie look's, and rule beats border", (half) => {
    const line = (t: Theme, token: "border" | "rule") => contrast(t[half]?.[token] ?? "", t[half]?.background ?? "");
    const old = OLD_DEFAULT[half];
    expect(line(theme, "border")).toBeGreaterThan(contrast(old.border, old.background));
    expect(line(theme, "rule")).toBeGreaterThan(contrast(old.rule, old.background));
    expect(line(theme, "rule")).toBeGreaterThan(line(theme, "border"));
  });
});

// The counsel pairs (M57 spec 12, measured 2026-10-16). Destructive and blocked are drawn as text
// as well as marks, and the Send slot's refusal is the `status-working chip` pair under another
// name. Every shipped theme clears 4.5 on all of them, collie included (its light `destructive` on
// `background` is 5.77; the first Collie look's 4.38 was the one value that set its own floor).
describe("the counsel pairs", () => {
  const collie = shipped("collie");
  const pairs = ["destructive text on background", "destructive text on card", "status-blocked text on background", "status-blocked text on card"];

  it.each(SHIPPED_THEME_IDS.filter((id) => id !== "collie"))("%s holds 4.5 for destructive and blocked text and 3 for the icon", (id) => {
    const report = contrastReport(shipped(id), collie);
    for (const half of ["light", "dark"] as const) {
      for (const check of pairs) {
        const f = report.find((r) => r.half === half && r.check === check);
        expect(f?.floor, `${half} ${check}`).toBe(4.5);
        expect(f?.ratio, `${half} ${check}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const check of ["destructive on background", "destructive on card"]) {
        const f = report.find((r) => r.half === half && r.check === check);
        expect(f?.floor).toBe(3);
        expect(f?.pass, `${half} ${check}`).toBe(true);
      }
    }
  });

  it("holds collie to 4.5 on every one of the four pairs, in both halves", () => {
    const report = contrastReport(collie, collie);
    const floors = report.filter((r) => pairs.includes(r.check));
    expect(floors).toHaveLength(8);
    for (const f of floors) expect(f.floor, `${f.half} ${f.check}`).toBe(4.5);
    expect(floors.filter((r) => !r.pass)).toEqual([]);
  });

  it("measures the refusal notice, status-working text on its 15 percent wash, on page and card in every theme", () => {
    for (const id of SHIPPED_THEME_IDS) {
      const report = contrastReport(shipped(id), collie);
      for (const half of ["light", "dark"] as const) {
        for (const ground of ["background", "card"]) {
          const f = report.find((r) => r.half === half && r.check === `status-working chip on ${ground}`);
          expect(f?.pass, `${id} ${half} ${ground}`).toBe(true);
        }
      }
    }
  });

  it("refuses a theme whose destructive text is worse than the default's", () => {
    const worse: Theme = { version: 1, id: "worse", name: "Worse", light: { destructive: "#e0a0a0" } };
    const fails = contrastReport(worse, collie).filter((r) => !r.pass).map((r) => r.check);
    expect(fails).toContain("destructive text on background");
  });
});

describe("themes.css", () => {
  const dir = resolve(web, "src/themes");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => ({ name, raw: readFileSync(resolve(dir, name), "utf8") }));

  // The in-process twin of `bun scripts/build-themes.ts --check`: the same function, the same files.
  it("is what scripts/build-themes.ts would write", () => {
    const result = buildThemesCss(files);
    expect(result.ok ? "" : result.errors.join("\n")).toBe("");
    expect(result.ok && result.css).toBe(read("src/themes.css"));
  });

  it("writes no block for the default theme", () => {
    expect(read("src/themes.css")).not.toContain('data-theme="collie"');
  });

  it("is imported right after the :root token block", () => {
    const close = css.indexOf("\n}\n", css.indexOf("\n:root {\n"));
    const imp = css.indexOf('@import "./themes.css";');
    expect(imp).toBeGreaterThan(close);
    const between = css.slice(close + 3, imp).replaceAll(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(between).toBe("");
  });

  it("writes one full block for another theme, filled from collie", () => {
    const extra = { name: "zz.json", raw: JSON.stringify({ version: 1, id: "zz", name: "Zz", dark: { background: "#000000" } }) };
    const result = buildThemesCss([...files, extra]);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const block = result.css.slice(result.css.indexOf(':root[data-theme="zz"] {'));
    expect(block).toContain("  --background: light-dark(oklch(0.955 0.003 80), #000000);\n");
    expect(block).toContain("  --border: light-dark(oklch(0.82 0.004 80), oklch(0.42 0.003 80));\n");
    expect(block.match(/^ {2}--/gm)).toHaveLength(THEME_TOKENS.length);
  });

  it("refuses a file named after another id, and a bad file, with every reason", () => {
    const wrong = { name: "a.json", raw: JSON.stringify({ version: 1, id: "b", name: "B", light: { card: "#000000" } }) };
    const bad = { name: "c.json", raw: '{"version":2}' };
    const result = buildThemesCss([...files, wrong, bad]);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors.some((e) => e.startsWith("a.json: the file must be named after its id"))).toBe(true);
    expect(errors.filter((e) => e.startsWith("c.json:")).length).toBeGreaterThan(1);
  });

  it("refuses to build without the collie theme", () => {
    const result = buildThemesCss([]);
    expect(result.ok ? [] : result.errors).toEqual(["collie.json: missing or refused; every other theme is filled from it"]);
  });
});

// ── The shape tokens, schema version 2 (M57 spec 14) ─────────────────────────────────────────────
//
// Every default word must be what the app drew before version 2, or the Collie theme changes the day
// the table lands. Today's values live in two places: index.css, and Tailwind's own theme.css for
// what index.css never set. Both are read from disk here.

const tailwindTheme = readFileSync(resolve(web, "node_modules/tailwindcss/theme.css"), "utf8");

/** The declarations of one `@theme` block of index.css (`@theme {` or `@theme inline {`), comments cut. */
function themeBlock(opener: string): Map<string, string> {
  const start = css.indexOf(`\n${opener}\n`);
  expect(start, opener).toBeGreaterThan(-1);
  const end = css.indexOf("\n}\n", start);
  return declarations(css.slice(start, end));
}

function declarations(text: string): Map<string, string> {
  const body = text.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", flat(m[2] ?? "")]));
}

/** index.css's `:root` token block. */
function rootDeclarations(): Map<string, string> {
  const start = css.indexOf("\n:root {\n");
  return declarations(css.slice(start, css.indexOf("\n}\n", start)));
}

/** Tailwind's value for a theme variable, from its shipped theme.css. */
function tailwind(property: string): string | undefined {
  return declarations(tailwindTheme).get(property);
}

describe("every default shape word is the stylesheet's CSS", () => {
  const root = rootDeclarations();
  const theme = themeBlock("@theme {");
  const inline = themeBlock("@theme inline {");

  it("radius: sharp is the four 2px steps, now in @theme and no longer in @theme inline", () => {
    for (const [property, value] of wordDeclarations("radius", SURFACE_DEFAULTS.radius)) {
      if (property === "--edge-accent" || property === "--edge-shadow") continue;
      expect(theme.get(property), property).toBe(value);
      expect(value).toBe("2px");
      expect(inline.has(property), property).toBe(false);
    }
    // The base radius stays where it was, and bare `rounded` and `rounded-full` are not steps.
    expect(root.get("--radius")).toBe("2px");
  });

  it("radius: sharp's row mark is the left bar every accent used to spell, declared on :root", () => {
    const edge = new Map(wordDeclarations("radius", SURFACE_DEFAULTS.radius)).get("--edge-accent");
    expect(edge).toBe("inset 2px 0 0 0");
    expect(root.get("--edge-accent")).toBe(edge);
    expect(theme.has("--edge-accent") || inline.has("--edge-accent")).toBe(false);
    // Its second shadow layer is none, so a marked row draws what it drew before.
    const second = new Map(wordDeclarations("radius", SURFACE_DEFAULTS.radius)).get("--edge-shadow");
    expect(second).toBe("0 0 #0000");
    expect(root.get("--edge-shadow")).toBe(second);
  });

  it("shadow: flat is the default, declared on :root, and the word `default` is Tailwind's own value for every step", () => {
    for (const [property, value] of wordDeclarations("shadow", SURFACE_DEFAULTS.shadow)) {
      const step = property.replace("--surface-shadow", "--shadow");
      expect(value).toBe("0 0 #0000");
      expect(root.get(property), property).toBe(value);
      expect(inline.get(step), step).toBe(`var(${property})`);
    }
    for (const [property, value] of wordDeclarations("shadow", "default")) {
      expect(tailwind(property.replace("--surface-shadow", "--shadow")), property).toBe(value);
    }
  });

  it("density: default is Tailwind's spacing step, which index.css does not set on :root", () => {
    const [[property, value] = ["", ""]] = wordDeclarations("density", SURFACE_DEFAULTS.density);
    expect(property).toBe("--spacing");
    expect(tailwind("--spacing")).toBe(value);
    expect(root.has("--spacing")).toBe(false);
    expect(theme.has("--spacing") || inline.has("--spacing")).toBe(false);
  });

  it("weight: bold is the default, declared on :root, and the word `default` is Tailwind's medium and semibold", () => {
    for (const [property, value] of wordDeclarations("weight", SURFACE_DEFAULTS.weight)) {
      expect(root.get(property), property).toBe(value);
      expect(theme.has(property) || inline.has(property), property).toBe(false);
    }
    for (const [property, value] of wordDeclarations("weight", "default")) expect(tailwind(property), property).toBe(value);
  });

  it("border: default is 1px, the width Tailwind falls back to when no theme sets one", () => {
    const [[property, value] = ["", ""]] = wordDeclarations("border", SURFACE_DEFAULTS.border);
    expect(root.get(property)).toBe(value);
    expect(value).toBe("1px");
    // Tailwind 4.3.1 declares no --default-border-width and falls back to 1px in the utility.
    expect(tailwind("--default-border-width")).toBeUndefined();
    expect(inline.get("--default-border-width")).toBe(`var(${property})`);
  });

  it("pins icons and the header mark box to the default spacing step", () => {
    const pin = /svg,\s*\[data-slot="collie-mark"\]\s*\{\s*--spacing:\s*([^;]+);/.exec(css.replaceAll(/\/\*[\s\S]*?\*\//g, ""));
    expect(pin?.[1]).toBe(wordDeclarations("density", "default")[0]?.[1]);
  });

  it("writes no shape line for a shipped file without a surface block, and the words for one with", () => {
    // Nightwatch ships version 2 parts (a surface block since spec 15, a display face and a terminal
    // palette since spec 18); its version 1 copy without them is the colour-only case.
    const raw = JSON.parse(read("src/themes/nightwatch.json"));
    delete raw.surface;
    delete raw.ansi;
    delete raw.light["pane-active"];
    delete raw.dark["pane-active"];
    raw.fonts = { ui: raw.fonts.ui };
    const collieFile = { name: "collie.json", raw: read("src/themes/collie.json") };
    const plain = buildThemesCss([collieFile, { name: "nightwatch.json", raw: JSON.stringify({ ...raw, version: 1 }) }]);
    if (!plain.ok) throw new Error(plain.errors.join("\n"));
    expect(plain.css).not.toMatch(/--radius-|--spacing|--surface-|--font-weight-|--ansi-|--font-display/);
    const withSurface = buildThemesCss([collieFile, { name: "nightwatch.json", raw: JSON.stringify({ ...raw, version: 2, surface: { radius: "soft", density: "roomy" } }) }]);
    if (!withSurface.ok) throw new Error(withSurface.errors.join("\n"));
    expect(withSurface.css).toContain("  --radius-md: 6px;\n");
    expect(withSurface.css).toContain("  --spacing: 0.28rem;\n");
    expect(withSurface.css).not.toContain("--surface-shadow");
  });
});

// ── The seven more tokens (M57 spec 17) ──────────────────────────────────────────────────────────
//
// Same rule as above: every default is what the app drew before. The literals each one replaced are
// read from the stylesheet, Tailwind's theme, or lucide's own defaults on disk.

describe("every default word of spec 17 is the stylesheet's CSS", () => {
  const root = rootDeclarations();
  const inline = themeBlock("@theme inline {");
  const bare = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const DEFAULTS = {
    ground: wordDeclarations("ground", SURFACE_DEFAULTS.ground),
    chrome: wordDeclarations("chrome", SURFACE_DEFAULTS.chrome),
    rows: wordDeclarations("rows", SURFACE_DEFAULTS.rows),
    icons: wordDeclarations("icons", SURFACE_DEFAULTS.icons),
    labels: wordDeclarations("labels", SURFACE_DEFAULTS.labels),
  };
  const defaultOf = (token: keyof typeof DEFAULTS) => DEFAULTS[token];

  it("declares every default word's properties on :root with the word's own values", () => {
    for (const token of ["ground", "chrome", "rows", "icons", "labels"] as const) {
      for (const [property, value] of defaultOf(token)) expect(root.get(property), property).toBe(value);
    }
  });

  it("ground: flat is no image, and the page colour moved from body to html unchanged", () => {
    expect(new Map(defaultOf("ground")).get("--ground-image")).toBe("none");
    const html = /\n {2}html \{([\s\S]*?)\n {2}\}/.exec(bare)?.[1] ?? "";
    expect(html).toContain("background-color: var(--background);");
    expect(html).toContain("background-image: var(--ground-image);");
    expect(html).toContain("min-height: 100%;");
    expect(bare).not.toContain("background-attachment");
    const body = /\n {2}body \{([\s\S]*?)\n {2}\}/.exec(bare)?.[1] ?? "";
    expect(body).toContain("@apply text-foreground;");
    expect(body).not.toContain("bg-background");
  });

  it("chrome: band is --secondary with a --border edge, the word `page` is the page colour and --rule, and the two band colours read them", () => {
    expect(defaultOf("chrome")).toEqual([
      ["--band-ground", "var(--secondary)"],
      ["--band-rule", "var(--border)"],
    ]);
    expect(wordDeclarations("chrome", "page")).toEqual([
      ["--band-ground", "var(--background)"],
      ["--band-rule", "var(--rule)"],
    ]);
    expect(inline.get("--color-band-ground")).toBe("var(--band-ground)");
    expect(inline.get("--color-band-rule")).toBe("var(--band-rule)");
  });

  it("rows: rules is the framed group with a border-wide line between rows and no edge, corner, shadow, gap or fill", () => {
    expect(new Map(defaultOf("rows"))).toEqual(
      new Map([
        ["--row-gap", "0px"],
        ["--row-rule", "var(--surface-border-width)"],
        ["--row-edge", "0px"],
        ["--row-corner", "0px"],
        ["--row-shadow", "none"],
        ["--row-inset", "0px"],
        ["--row-fill", "transparent"],
      ]),
    );
    expect(bare).toMatch(/\[data-slot="list-group"\] > :not\(:last-child\) \{\s*border-bottom-width: var\(--surface-border-width\);/);
  });

  it("icons: default is lucide's own stroke width", () => {
    const lucide = read("node_modules/lucide-react/dist/esm/defaultAttributes.mjs");
    const stroke = /strokeWidth:\s*(\d+(?:\.\d+)?)/.exec(lucide)?.[1];
    expect(new Map(defaultOf("icons")).get("--icon-stroke")).toBe(stroke);
    expect(bare).toMatch(/svg\.lucide \{\s*stroke-width: var\(--icon-stroke\);/);
  });

  it("labels: sentence is the default, and the word `caps` is `uppercase` and Tailwind's `tracking-wide`", () => {
    expect(new Map(defaultOf("labels"))).toEqual(new Map([["--label-transform", "none"], ["--label-tracking", "normal"]]));
    const words = new Map(wordDeclarations("labels", "caps"));
    expect(words.get("--label-transform")).toBe("uppercase");
    expect(words.get("--label-tracking")).toBe(tailwind("--tracking-wide"));
    expect(bare).toMatch(/@utility label-caps \{\s*text-transform: var\(--label-transform, uppercase\);\s*letter-spacing: var\(--label-tracking, 0\.025em\);/);
  });

  it("display: the default display face is Aldrich, and each face's stack is the one its Typeface class sets", () => {
    expect(root.get("--font-display")).toBe("var(--face-aldrich)");
    for (const face of FACES) {
      const [[, value] = ["", ""]] = displayDeclarations(face);
      expect(value).toBe(`var(--face-${face})`);
      const stack = root.get(`--face-${face}`);
      const own =
        face === "aldrich"
          ? inline.get("--font-sans")
          : flat(/--font-sans:\s*([^;]+);/.exec(bare.slice(bare.indexOf(`:root.font-${face} {`)))?.[1] ?? "");
      expect(stack, face).toBe(own);
    }
  });
});

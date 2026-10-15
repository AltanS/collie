import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHIPPED_FONTS } from "@/lib/design";
import { SHIPPED_THEME_IDS, THEME_TOKENS, contrast, contrastReport, parseTheme, type Theme } from "@/lib/theme/schema";
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

describe("the theme collie equals index.css", () => {
  const tokens = rootTokens();
  const collie = shipped("collie");

  it("finds all 43 tokens in index.css, in the order of the token list", () => {
    expect(tokens.map((t) => t.token)).toEqual([...THEME_TOKENS]);
  });

  it("reads the multi-line pairs whole", () => {
    const byName = new Map(tokens.map((t) => [t.token, t]));
    expect(byName.get("control-on-foreground")).toEqual({
      token: "control-on-foreground",
      light: "oklch(0.38 0.12 245)",
      dark: "oklch(0.89 0.06 235)",
    });
    expect(byName.get("destructive")?.dark).toBe("oklch(0.704 0.191 22.216)");
    expect(byName.get("border")?.dark).toBe("oklch(1 0 0 / 12%)");
  });

  it("holds every token of both halves, string for string", () => {
    const byName = new Map(tokens.map((t) => [t.token, t]));
    for (const token of THEME_TOKENS) {
      const row = byName.get(token);
      expect({ token, light: collie.light?.[token] }).toEqual({ token, light: row?.light });
      expect({ token, dark: collie.dark?.[token] }).toEqual({ token, dark: row?.dark });
    }
    expect(Object.keys(collie.light ?? {})).toHaveLength(THEME_TOKENS.length);
    expect(Object.keys(collie.dark ?? {})).toHaveLength(THEME_TOKENS.length);
  });

  it("carries the default face and the shipped author", () => {
    expect(collie.fonts).toEqual({ ui: "aldrich" });
    expect(collie.author).toBe("Collie");
    expect(SHIPPED_FONTS).toContain("aldrich");
  });

  // The collie theme is the look index.css already measured, so every check passes but one, and the
  // one is recorded here so nobody re-derives it: dark `destructive-foreground` (near white) on dark
  // `destructive` (a light red) is 2.77:1. It is the shadcn stock pair, drawn only on a filled
  // destructive button and an armed action-sheet row. Changing it changes the current look, which
  // M57 does not do; a theme of its own may pick a better pair.
  it("passes every check but the one recorded known failure", () => {
    const fails = contrastReport(collie, collie).filter((f) => !f.pass);
    expect(fails).toEqual([
      { half: "dark", check: "destructive-foreground on destructive", ratio: 2.77, floor: 4.5, pass: false },
    ]);
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
    expect(Object.keys(theme.light ?? {}).toSorted()).toEqual([...THEME_TOKENS].toSorted());
    expect(Object.keys(theme.dark ?? {}).toSorted()).toEqual([...THEME_TOKENS].toSorted());
    expect(SHIPPED_FONTS).toContain(theme.fonts?.ui);
    expect(theme.author).toBe("Collie");
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

  it.each(["light", "dark"] as const)("%s: body text is AAA, 7:1 or better, on the page and on a card", (half) => {
    for (const check of ["foreground on background", "foreground on card", "muted-foreground on background", "muted-foreground on card"]) {
      expect(find(half, check), check).toBeGreaterThanOrEqual(7);
    }
  });

  it.each(["light", "dark"] as const)("%s: blocked and done sit 0.25 or more apart in oklab", (half) => {
    expect(find(half, "status-blocked apart from status-done")).toBeGreaterThanOrEqual(0.25);
  });

  // A step stronger than collie on both lines, and rule still the stronger of the two.
  it.each(["light", "dark"] as const)("%s: border and rule are stronger than collie's, and rule beats border", (half) => {
    const line = (t: Theme, token: "border" | "rule") => contrast(t[half]?.[token] ?? "", t[half]?.background ?? "");
    const collie = shipped("collie");
    expect(line(theme, "border")).toBeGreaterThan(line(collie, "border"));
    expect(line(theme, "rule")).toBeGreaterThan(line(collie, "rule"));
    expect(line(theme, "rule")).toBeGreaterThan(line(theme, "border"));
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
    expect(block).toContain("  --background: light-dark(oklch(0.97 0 0), #000000);\n");
    expect(block).toContain("  --border: light-dark(oklch(0.922 0 0), oklch(1 0 0 / 12%));\n");
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

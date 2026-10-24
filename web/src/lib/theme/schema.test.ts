import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/json";

import {
  ALL_THEME_TOKENS,
  OPTIONAL_THEME_TOKENS,
  setsOptionalToken,
  SHIPPED_THEME_IDS,
  THEME_TOKENS,
  THEME_VERSION,
  THEME_VERSIONS_READ,
  ANSI_BRIGHT_LUMINANCE,
  contrast,
  mixOklab,
  versionOf,
  contrastReport,
  fillHalves,
  isColour,
  lightDark,
  parseTheme,
  toSrgbHex,
  type ParsedTheme,
  type Refusal,
  type Theme,
} from "./schema";
import { ANSI_KEYS, SURFACE_DEFAULTS, SURFACE_TOKENS, resolveSurface, surfaceWords } from "./surface";
import { BRIGHT_FG_LUMINANCE, luminance as museLuminance } from "../harness/muse/display";

const CAP = { maxBytes: 64 * 1024 };

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "../../..", p), "utf8");

function file(extra: JsonObject): string {
  return JSON.stringify({ version: 1, id: "mine", name: "Mine", light: { background: "#ffffff" }, ...extra });
}

function refusals(result: ParsedTheme): Refusal[] {
  return result.ok ? [] : result.refusals;
}

function codes(result: ParsedTheme): string[] {
  return refusals(result).map((r) => `${r.code} ${r.path}`);
}

describe("the token list", () => {
  it("holds 43 tokens, each once", () => {
    expect(THEME_TOKENS).toHaveLength(43);
    expect(new Set(THEME_TOKENS).size).toBe(43);
    expect(THEME_TOKENS).not.toContain("popover");
    expect(THEME_TOKENS).not.toContain("radius");
    expect(THEME_VERSION).toBe(3);
    expect(SHIPPED_THEME_IDS).toEqual(["collie", "nightwatch", "daylight", "harbour"]);
  });
});

describe("isColour", () => {
  it.each([
    "#000000",
    "#a1B2c3",
    "#a1b2c3d4",
    "oklch(0.97 0 0)",
    "oklch(1 0 0 / 12%)",
    "oklch(0.5 0.1 20 / 0.5)",
    "oklch(.5 .1 360)",
    "  OKLCH(0.5   0.1  20)  ",
  ])("accepts %s", (value) => {
    expect(isColour(value)).toBe(true);
  });

  it.each([
    "url(x)",
    "var(--x)",
    "red",
    "#fff",
    "#ggg",
    "#gggggg",
    "rgb(0 0 0)",
    "oklch(0.5 0.1 20) ; color: red",
    "oklch(0.5 0.1 20)}",
    "oklch(2 0 0)",
    "oklch(0.5 0.6 20)",
    "oklch(0.5 0.1 400)",
    "oklch(0.5 0.1 20 / 2)",
    "oklch(0.5 0.1 20 / 101%)",
    "oklch(-0.5 0.1 20)",
    "oklch(50% 0.1 20)",
    "oklch(0.5 0.1 20deg)",
    "oklch(calc(1) 0 0)",
    "oklch(0.5 0.1 20)<",
    "oklch(0.5 0.1 20)\\",
    "",
    "x".repeat(10 * 1024),
  ])("rejects %j", (value) => {
    expect(isColour(value)).toBe(false);
  });
});

describe("parseTheme", () => {
  it("accepts a small theme and normalises its values", () => {
    const result = parseTheme(
      file({ author: "Me", dark: { "status-blocked": " OKLCH(0.7  0.2 24) " }, fonts: { ui: "grotesk" } }),
      CAP,
    );
    expect(result).toEqual({
      ok: true,
      theme: {
        version: 1,
        id: "mine",
        name: "Mine",
        author: "Me",
        light: { background: "#ffffff" },
        dark: { "status-blocked": "oklch(0.7 0.2 24)" },
        fonts: { ui: "grotesk" },
      },
    });
  });

  it("ignores $schema", () => {
    expect(parseTheme(file({ $schema: "https://example.invalid/theme.json" }), CAP).ok).toBe(true);
  });

  it("carries no key for an absent field", () => {
    const result = parseTheme(file({}), CAP);
    expect(result.ok && Object.keys(result.theme)).toEqual(["version", "id", "name", "light"]);
  });

  it("refuses a file over the cap before parsing it", () => {
    const big = file({ author: "x".repeat(65 * 1024) });
    expect(codes(parseTheme(big, CAP))).toEqual(["size $"]);
    expect(refusals(parseTheme(big, CAP))[0]?.detail).toContain("65536");
  });

  it("counts the cap in bytes, not characters", () => {
    const raw = file({ name: "Ü".repeat(20) });
    const bytes = new TextEncoder().encode(raw).length;
    expect(bytes).toBeGreaterThan(raw.length);
    expect(codes(parseTheme(raw, { maxBytes: raw.length }))).toEqual(["size $"]);
    expect(parseTheme(raw, { maxBytes: bytes }).ok).toBe(true);
  });

  it.each(["", "not json", "[]", "1", "null", '"x"'])("refuses %j as not a JSON object", (raw) => {
    expect(codes(parseTheme(raw, CAP))).toEqual(["json $"]);
  });

  it("names an unknown version", () => {
    const r = refusals(parseTheme(file({ version: 4 }), CAP));
    expect(r.map((x) => x.code)).toEqual(["version"]);
    expect(r[0]?.detail).toContain("version 4");
    expect(r[0]?.detail).toContain("reads version 1, 2 and 3");
    expect(codes(parseTheme(file({ version: "1" }), CAP))).toEqual(["version version"]);
  });

  it("refuses a missing version", () => {
    const raw = JSON.stringify({ id: "mine", name: "Mine", light: { background: "#ffffff" } });
    expect(refusals(parseTheme(raw, CAP))[0]?.detail).toContain("no version");
  });

  it.each(["", "Mine", "-mine", "a".repeat(33), "mine_1", "mine.json", 7])("refuses the id %j", (id) => {
    expect(codes(parseTheme(file({ id }), CAP))).toEqual(["id id"]);
  });

  it("accepts an id of 32 characters", () => {
    expect(parseTheme(file({ id: "a".repeat(32) }), CAP).ok).toBe(true);
  });

  it.each(SHIPPED_THEME_IDS)("refuses the shipped id %s on import, and allows it for a shipped file", (id) => {
    expect(codes(parseTheme(file({ id }), CAP))).toEqual(["reserved-id id"]);
    expect(parseTheme(file({ id }), { ...CAP, allowReservedId: true }).ok).toBe(true);
  });

  it.each(["", "   ", "x".repeat(41), 3, null])("refuses the name %j", (name) => {
    expect(codes(parseTheme(file({ name }), CAP))).toEqual(["name name"]);
  });

  it("counts the name in characters a person sees", () => {
    expect(parseTheme(file({ name: "\u{1F415}".repeat(40) }), CAP).ok).toBe(true);
  });

  it.each(["x".repeat(61), 3, false])("refuses the author %j", (author) => {
    expect(codes(parseTheme(file({ author }), CAP))).toEqual(["author author"]);
  });

  it.each(["a\nb", "a\u0000b", "a\tb", "a\u007fb", "a\u0085b", "a\u009fb", "a\nb\u0000<script>"])(
    "refuses a name or an author with the control character in %j",
    (text) => {
      const named = refusals(parseTheme(file({ name: text }), CAP));
      expect(named.map((r) => `${r.code} ${r.path}`)).toEqual(["name name"]);
      expect(named[0]?.detail).toContain("control character");
      const authored = refusals(parseTheme(file({ author: text }), CAP));
      expect(authored.map((r) => `${r.code} ${r.path}`)).toEqual(["author author"]);
      expect(authored[0]?.detail).toContain("control character");
    },
  );

  it("keeps a name with characters past the C1 range", () => {
    expect(parseTheme(file({ name: "Caf\u00e9 \u00a0Nuit" }), CAP).ok).toBe(true);
  });

  it("lists 25 refusals at most, and counts the rest in one last row", () => {
    const doc: Record<string, number> = {};
    for (let i = 0; i < 4000; i += 1) doc[`k${i}`] = i;
    const r = refusals(parseTheme(file(doc), CAP));
    expect(r).toHaveLength(26);
    expect(r.slice(0, 25).every((x) => x.code === "unknown-key")).toBe(true);
    expect(r[25]).toEqual({ code: "json", path: "$", detail: "and 3975 more" });
  });

  it("lists exactly 25 refusals with no count row", () => {
    const doc: Record<string, number> = {};
    for (let i = 0; i < 25; i += 1) doc[`k${i}`] = i;
    expect(refusals(parseTheme(file(doc), CAP))).toHaveLength(25);
  });

  it("names every unknown key, at every level", () => {
    const raw = file({
      colours: {},
      light: { background: "#ffffff", popover: "#ffffff", radius: "#ffffff" },
      dark: { "ansi-1": "#ffffff" },
      fonts: { ui: "aldrich", mono: "x" },
    });
    expect(codes(parseTheme(raw, CAP))).toEqual([
      "unknown-key colours",
      "unknown-key light.popover",
      "unknown-key light.radius",
      "unknown-key dark.ansi-1",
      "unknown-key fonts.mono",
    ]);
    expect(refusals(parseTheme(raw, CAP))[1]?.detail).toContain('"light.popover"');
  });

  it("refuses a mark as an unknown key, whichever mark it names", () => {
    for (const mark of ["collie", "nightwatch", "harbour"]) {
      expect(codes(parseTheme(file({ mark }), CAP))).toEqual(["unknown-key mark"]);
    }
  });

  it("refuses a __proto__ key instead of following it", () => {
    const raw = '{"version":1,"id":"mine","name":"Mine","light":{"__proto__":{"background":"#000000"}}}';
    expect(codes(parseTheme(raw, CAP))).toEqual(["unknown-key light.__proto__"]);
  });

  it("names every bad value", () => {
    const raw = file({
      light: { background: "url(x)", foreground: "var(--x)", card: "red", chrome: 12 },
      dark: { rule: "oklch(0.5 0.1 20) ; color: red" },
    });
    expect(codes(parseTheme(raw, CAP))).toEqual([
      "value light.background",
      "value light.foreground",
      "value light.card",
      "value light.chrome",
      "value dark.rule",
    ]);
  });

  // The two shapes a stylesheet could smuggle through a colour slot (M57 spec 12): a rule that loads a
  // file, and a function that paints an image. Both are refused as values, by name, and the whole
  // theme with them.
  it.each(["@import url(x)", "@import url(https://x.test/a.css)", "linear-gradient(red, blue)", "radial-gradient(#000000, #ffffff)"])(
    "refuses %s as a colour and names the token",
    (value) => {
      expect(isColour(value)).toBe(false);
      expect(codes(parseTheme(file({ light: { background: value }, dark: { background: "#000000" } }), CAP))).toEqual([
        "value light.background",
      ]);
    },
  );

  it("refuses a half that is not an object", () => {
    expect(codes(parseTheme(file({ light: "#ffffff" }), CAP))).toEqual(["value light"]);
    expect(codes(parseTheme(file({ dark: ["#ffffff"] }), CAP))).toEqual(["value dark"]);
  });

  it("refuses a file with no colour", () => {
    const raw = JSON.stringify({ version: 1, id: "mine", name: "Mine" });
    expect(codes(parseTheme(raw, CAP))).toEqual(["no-half $"]);
    expect(codes(parseTheme(file({ light: {} }), CAP))).toEqual(["no-half $"]);
  });

  it("accepts a dark half alone", () => {
    const raw = JSON.stringify({ version: 1, id: "mine", name: "Mine", dark: { background: "#000000" } });
    const result = parseTheme(raw, CAP);
    expect(result.ok && result.theme.light).toBeUndefined();
  });

  it.each([{ ui: "comic-sans" }, { ui: 1 }, "aldrich"])("refuses the font %j", (fonts) => {
    expect(codes(parseTheme(file({ fonts }), CAP)).map((c) => c.split(" ")[0])).toEqual(["font"]);
  });

  it("collects every refusal in one pass", () => {
    const raw = JSON.stringify({
      version: 4,
      id: "Bad Id",
      name: "",
      author: 4,
      extra: true,
      light: { nope: "#000000", background: "red" },
      fonts: { ui: "x" },
    });
    expect(codes(parseTheme(raw, CAP))).toEqual([
      "unknown-key extra",
      "version version",
      "id id",
      "name name",
      "author author",
      "unknown-key light.nope",
      "value light.background",
      "font fonts.ui",
    ]);
  });

  it("never throws, and every refusal says where and why", () => {
    const inputs = ["{", "{}", "{\"light\":null}", "\u0000", "{\"version\":1e400}", JSON.stringify({ fonts: null })];
    for (const raw of inputs) {
      const result = parseTheme(raw, CAP);
      expect(result.ok).toBe(false);
      for (const r of refusals(result)) {
        expect(r.path).not.toBe("");
        expect(r.detail).not.toBe("");
        expect(r.detail).not.toMatch(/\u2014/);
      }
    }
  });
});

describe("toSrgbHex", () => {
  it.each([
    ["oklch(0.97 0 0)", "#f5f5f5"],
    ["oklch(0.145 0 0)", "#0a0a0a"],
    ["oklch(0.48 0 0)", "#5d5d5d"],
    ["oklch(0.708 0 0)", "#a1a1a1"],
  ])("converts the measured literal %s to %s", (value, hex) => {
    expect(toSrgbHex(value)).toBe(hex);
  });

  it("drops the alpha of a hex value and lower-cases it", () => {
    expect(toSrgbHex("#AABBCC80")).toBe("#aabbcc");
  });

  it("clamps a colour outside sRGB into gamut", () => {
    expect(toSrgbHex("oklch(0.7 0.4 140)")).toMatch(/^#[0-9a-f]{6}$/);
    expect(toSrgbHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(toSrgbHex("oklch(0 0 0)")).toBe("#000000");
  });
});

describe("contrast", () => {
  it("is the WCAG ratio, both ways round", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("lays a translucent ink over its ground, as index.css measured --rule", () => {
    // index.css: --rule against --background is 1.34 light and 2.06 dark.
    expect(contrast("oklch(0.875 0 0)", "oklch(0.97 0 0)")).toBeCloseTo(1.34, 1);
    expect(contrast("oklch(1 0 0 / 24%)", "oklch(0.145 0 0)")).toBeCloseTo(2.06, 1);
  });

  it("gives 1 for a value that is not a colour", () => {
    expect(contrast("red", "#000000")).toBe(1);
  });
});

describe("fillHalves and lightDark", () => {
  const base: Theme = {
    version: 1,
    id: "collie",
    name: "Collie",
    light: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#ffffff"])),
    dark: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#000000"])),
  };

  it("fills token by token, and a missing half whole", () => {
    const theme: Theme = { version: 1, id: "mine", name: "Mine", light: { background: "#123456" } };
    const filled = fillHalves(theme, base);
    expect(filled.light.background).toBe("#123456");
    expect(filled.light.foreground).toBe("#ffffff");
    expect(filled.dark.background).toBe("#000000");
    expect(lightDark(filled, "background")).toBe("light-dark(#123456, #000000)");
  });

  it("throws only when the base itself is incomplete", () => {
    const filled = fillHalves({ version: 1, id: "a", name: "A" }, { version: 1, id: "b", name: "B" });
    expect(() => lightDark(filled, "ring")).toThrow(/ring/);
  });
});

describe("contrastReport", () => {
  const base: Theme = {
    version: 1,
    id: "collie",
    name: "Collie",
    light: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#000000"])),
    dark: Object.fromEntries(THEME_TOKENS.map((t) => [t, "#ffffff"])),
  };

  it("runs every check in both halves", () => {
    const findings = contrastReport({ version: 1, id: "a", name: "A" }, base);
    const checks = findings.filter((f) => f.half === "light").map((f) => f.check);
    expect(checks).toEqual([
      "foreground on background",
      "foreground on card",
      "muted-foreground on background",
      "muted-foreground on card",
      "primary-foreground on primary",
      "destructive-foreground on destructive",
      "status-blocked chip on background",
      "status-blocked chip on card",
      "status-working chip on background",
      "status-working chip on card",
      "status-done chip on background",
      "status-done chip on card",
      "status-idle chip on background",
      "status-idle chip on card",
      "status-unknown chip on background",
      "status-unknown chip on card",
      "status-info chip on background",
      "status-info chip on card",
      "destructive on background",
      "destructive text on background",
      "status-blocked text on background",
      "destructive on card",
      "destructive text on card",
      "status-blocked text on card",
      "rule on background",
      "status-blocked apart from status-done",
    ]);
    expect(findings.filter((f) => f.half === "dark")).toHaveLength(checks.length);
  });

  it("fails a theme that paints text in its ground colour, and names the half", () => {
    const findings = contrastReport({ version: 1, id: "a", name: "A" }, base);
    expect(findings.every((f) => !f.pass)).toBe(true);
  });

  it("passes a theme with real contrast, filled from the base", () => {
    const theme: Theme = {
      version: 1,
      id: "a",
      name: "A",
      light: {
        background: "#ffffff",
        card: "#ffffff",
        primary: "#ffffff",
        destructive: "#b00000",
        "destructive-foreground": "#ffffff",
        rule: "#bbbbbb",
        "status-blocked": "#b00000",
        "status-done": "#006000",
      },
    };
    const light = contrastReport(theme, base).filter((f) => f.half === "light");
    expect(light.filter((f) => !f.pass)).toEqual([]);
  });

  it("measures the chip the pessimistic way, over the wash at 15 percent", () => {
    const theme: Theme = { version: 1, id: "a", name: "A", light: { background: "#ffffff", card: "#ffffff" } };
    const chip = contrastReport(theme, base).find((f) => f.half === "light" && f.check === "status-blocked chip on background");
    // Black ink over a 15 percent black wash on white: the wash is rgb(217), so the ratio is under 21.
    expect(chip?.ratio).toBeLessThan(contrast("#000000", "#ffffff"));
    expect(chip?.ratio).toBeCloseTo(contrast("#000000", "#d9d9d9"), 1);
  });
});

// ── Schema version 2: the surface block (M57 spec 14) ─────────────────────────────────────────

function v2(extra: JsonObject): string {
  return file({ version: 2, ...extra });
}

describe("versions", () => {
  it("reads versions 1, 2 and 3, and hands back the lowest version that holds the content", () => {
    expect(THEME_VERSIONS_READ).toEqual([1, 2, 3]);
    const one = parseTheme(file({}), CAP);
    const twoPlain = parseTheme(v2({}), CAP);
    const twoWithSurface = parseTheme(v2({ surface: { radius: "soft" } }), CAP);
    expect(one.ok && one.theme.version).toBe(1);
    expect(twoPlain.ok && twoPlain.theme.version).toBe(1);
    expect(twoWithSurface.ok && twoWithSurface.theme.version).toBe(2);
    expect(one.ok && versionOf(one.theme)).toBe(1);
    expect(twoWithSurface.ok && versionOf(twoWithSurface.theme)).toBe(2);
  });

  it("gives a version 1 file no surface, which is every default word", () => {
    const result = parseTheme(file({}), CAP);
    expect(result.ok && result.theme.surface).toBeUndefined();
    expect(result.ok && resolveSurface(result.theme.surface)).toEqual(SURFACE_DEFAULTS);
  });

  it("gives a version 2 file without a surface block every default word", () => {
    const result = parseTheme(v2({}), CAP);
    expect(result.ok && Object.keys(result.theme)).toEqual(["version", "id", "name", "light"]);
    expect(result.ok && resolveSurface(result.theme.surface)).toEqual(SURFACE_DEFAULTS);
  });

  it("refuses a surface block in a file that says version 1, and keeps nothing", () => {
    const result = parseTheme(file({ surface: { radius: "soft" } }), CAP);
    expect(codes(result)).toEqual(["version version"]);
    expect(refusals(result)[0]?.detail).toContain('"surface"');
    expect(refusals(result)[0]?.detail).toContain("version 2");
  });
});

describe("the surface block", () => {
  it("keeps the words a file names, and carries no key for the ones it leaves out", () => {
    const result = parseTheme(v2({ surface: { radius: "round", density: "roomy" } }), CAP);
    expect(result.ok && result.theme.surface).toEqual({ radius: "round", density: "roomy" });
    expect(result.ok && Object.keys(result.theme)).toEqual(["version", "id", "name", "light", "surface"]);
  });

  it("drops an empty block, so an export carries no empty key", () => {
    const result = parseTheme(v2({ surface: {} }), CAP);
    expect(result.ok && "surface" in result.theme).toBe(false);
  });

  it.each(SURFACE_TOKENS.flatMap((token) => surfaceWords(token).map((word) => [token, word] as const)))(
    "accepts %s: %s",
    (token, word) => {
      const result = parseTheme(v2({ surface: { [token]: word } }), CAP);
      expect(result.ok && result.theme.surface).toEqual({ [token]: word });
    },
  );

  it.each(SURFACE_TOKENS)("refuses an unknown word for %s, naming the token and its words", (token) => {
    const result = parseTheme(v2({ surface: { [token]: "bubbly" } }), CAP);
    expect(codes(result)).toEqual([`surface surface.${token}`]);
    const detail = refusals(result)[0]?.detail ?? "";
    expect(detail).toContain(`"surface.${token}"`);
    for (const word of surfaceWords(token)) expect(detail).toContain(word);
  });

  it.each(SURFACE_TOKENS)("refuses a number for %s, naming the token", (token) => {
    const result = parseTheme(v2({ surface: { [token]: 12 } }), CAP);
    expect(codes(result)).toEqual([`surface surface.${token}`]);
    expect(refusals(result)[0]?.detail).toContain(`"surface.${token}"`);
  });

  it.each([["0.28rem"], ["8px"], [true], [null], [["soft"]], [{ value: "soft" }], ["Soft"], [" soft "]])(
    "refuses %j as a radius word",
    (value) => {
      expect(codes(parseTheme(v2({ surface: { radius: value } }), CAP))).toEqual(["surface surface.radius"]);
    },
  );

  it("refuses a word that is another token's word", () => {
    expect(codes(parseTheme(v2({ surface: { radius: "roomy" } }), CAP))).toEqual(["surface surface.radius"]);
    expect(codes(parseTheme(v2({ surface: { density: "sharp" } }), CAP))).toEqual(["surface surface.density"]);
  });

  it("refuses an unknown key inside the block, by its path", () => {
    const result = parseTheme(v2({ surface: { radius: "soft", type: "large", "--spacing": "1rem" } }), CAP);
    expect(codes(result)).toEqual(["unknown-key surface.type", "unknown-key surface.--spacing"]);
  });

  it("refuses a block that is not an object", () => {
    for (const surface of ["soft", 1, null, ["radius"]]) {
      expect(codes(parseTheme(v2({ surface }), CAP))).toEqual(["surface surface"]);
    }
  });

  it("refuses the whole file for one bad word, so nothing of it is applied", () => {
    const result = parseTheme(v2({ surface: { radius: "soft", shadow: "huge" }, dark: { background: "#000000" } }), CAP);
    expect(result.ok).toBe(false);
  });

  it("does not read a word through the prototype", () => {
    const raw = '{"version":2,"id":"mine","name":"Mine","light":{"background":"#ffffff"},"surface":{"radius":"constructor","__proto__":{"radius":"soft"}}}';
    expect(codes(parseTheme(raw, CAP))).toEqual(["surface surface.radius", "unknown-key surface.__proto__"]);
  });
});

// ── Spec 17: the display face, the terminal palette, and the ground and band checks ──────────────

describe("the display face", () => {
  it.each(["system", "grotesk", "aldrich", "plex", "geist", "atkinson"])("accepts %s, and the file is version 2", (face) => {
    const result = parseTheme(v2({ fonts: { display: face } }), CAP);
    expect(result.ok && result.theme.fonts).toEqual({ display: face });
    expect(result.ok && result.theme.version).toBe(2);
  });

  it("keeps the UI face beside it, and a UI face alone stays version 1", () => {
    const both = parseTheme(v2({ fonts: { ui: "plex", display: "geist" } }), CAP);
    expect(both.ok && both.theme.fonts).toEqual({ ui: "plex", display: "geist" });
    const ui = parseTheme(v2({ fonts: { ui: "plex" } }), CAP);
    expect(ui.ok && ui.theme.version).toBe(1);
  });

  it.each([["comic-sans"], [1], [["geist"]], [null], ["Geist"], ["constructor"]])("refuses %j as a display face, naming it", (value) => {
    const result = parseTheme(v2({ fonts: { display: value } }), CAP);
    expect(codes(result)).toEqual(["font fonts.display"]);
    expect(refusals(result)[0]?.detail).toContain('"fonts.display"');
  });

  it("refuses a display face in a file that says version 1", () => {
    const result = parseTheme(file({ fonts: { display: "geist" } }), CAP);
    expect(codes(result)).toEqual(["version version"]);
    expect(refusals(result)[0]?.detail).toContain('"fonts.display"');
  });
});

function shippedCollie(): Theme {
  const base = parseTheme(read("src/themes/collie.json"), { ...CAP, allowReservedId: true });
  if (!base.ok) throw new Error("collie.json no longer parses");
  return base.theme;
}

/** Collie's own index.css palette on its own ground: a palette that passes the gate. */
const PALETTE = {
  "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510", "4": "#2472c8", "5": "#bc3fbc",
  "6": "#11a8cd", "7": "#e5e5e5", "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
  "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff", ink: "#fafafa", ground: "#0a0a0a",
};

describe("the terminal palette", () => {
  it("keeps a whole palette that passes the gate, normalised, as version 2", () => {
    const result = parseTheme(v2({ ansi: { ...PALETTE, "1": "#CD3131", ink: "oklch(0.985 0 0)" } }), CAP);
    expect(result.ok && result.theme.version).toBe(2);
    expect(result.ok && result.theme.ansi?.["1"]).toBe("#cd3131");
    expect(result.ok && result.theme.ansi?.ink).toBe("oklch(0.985 0 0)");
    expect(result.ok && Object.keys(result.theme.ansi ?? {})).toEqual([...ANSI_KEYS]);
  });

  it("refuses a palette in a file that says version 1", () => {
    expect(codes(parseTheme(file({ ansi: PALETTE }), CAP))).toEqual(["version version"]);
  });

  it("refuses a partial palette and names what it lacks", () => {
    const partial = Object.fromEntries(Object.entries(PALETTE).filter(([key]) => key !== "7" && key !== "ground"));
    const result = parseTheme(v2({ ansi: partial }), CAP);
    expect(codes(result)).toEqual(["ansi ansi"]);
    expect(refusals(result)[0]?.detail).toContain("It lacks: 7, ground.");
  });

  it("refuses an unknown key, a value that is not a colour, a translucent one and a block that is not an object", () => {
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "16": "#ffffff" } }), CAP))).toEqual(["unknown-key ansi.16"]);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "2": "green" } }), CAP))).toEqual(["ansi ansi.2"]);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "2": 2 } }), CAP))).toEqual(["ansi ansi.2"]);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "2": "#0dbc7980" } }), CAP))).toEqual(["ansi ansi.2"]);
    expect(codes(parseTheme(v2({ ansi: "#000000" }), CAP))).toEqual(["ansi ansi"]);
  });

  it("refuses ink under 4.5:1 on the ground, naming ansi.ink", () => {
    const result = parseTheme(v2({ ansi: { ...PALETTE, ink: "#555555" } }), CAP);
    expect(codes(result)).toEqual(["ansi ansi.ink"]);
    expect(refusals(result)[0]?.detail).toContain("The floor is 4.5.");
  });

  it("refuses a ground lighter than the ink: the palette is dark-space", () => {
    const light = { ...PALETTE, ink: "#0a0a0a", ground: "#fafafa" };
    expect(codes(parseTheme(v2({ ansi: light }), CAP))).toContain("ansi ansi.ground");
  });

  it("holds slots 1 to 7 and 9 to 15 at 3:1 on the ground, and lets slot 0 be black", () => {
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "4": "#202040" } }), CAP))).toEqual(["ansi ansi.4"]);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "8": "#202020" } }), CAP))).toEqual(["ansi ansi.8"]);
    expect(parseTheme(v2({ ansi: { ...PALETTE, "0": "#000000" } }), CAP).ok).toBe(true);
  });

  it("keeps the bright set the Muse decorator names: 3, 7, 11, 15 above the line, every other slot at or below it", () => {
    expect(ANSI_BRIGHT_LUMINANCE).toBe(BRIGHT_FG_LUMINANCE);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "3": "#a0a000" } }), CAP))).toEqual(["ansi ansi.3"]);
    expect(codes(parseTheme(v2({ ansi: { ...PALETTE, "10": "#69ff94" } }), CAP))).toEqual(["ansi ansi.10"]);
    // The schema's luminance and the decorator's agree on the line for the default palette.
    for (const [key, hex] of Object.entries(PALETTE)) {
      if (key === "ink" || key === "ground") continue;
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      expect(museLuminance(r ?? 0, g ?? 0, b ?? 0) > BRIGHT_FG_LUMINANCE, key).toBe(["3", "7", "11", "15"].includes(key));
    }
  });

  it("collects every failing slot at once", () => {
    const result = parseTheme(v2({ ansi: { ...PALETTE, "1": "#300000", "5": "#300030" } }), CAP);
    expect(codes(result)).toEqual(["ansi ansi.1", "ansi ansi.5"]);
  });
});

describe("the ground and the band in the contrast report", () => {
  const collie = shippedCollie();

  it("mixes in oklab the way color-mix draws it", () => {
    expect(mixOklab("#336699", "#336699", 40)).toBe("#336699");
    expect(mixOklab("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixOklab("#000000", "#ffffff", 100)).toBe("#ffffff");
    expect(mixOklab("oklch(0 0 0)", "oklch(1 0 0)", 50)).toBe(toSrgbHex("oklch(0.5 0 0)"));
  });

  it("adds no check for a flat ground under page chrome, so the report is the one it was", () => {
    const plain = contrastReport(collie, collie).map((f) => f.check);
    const flat = contrastReport({ ...collie, version: 2, surface: { ground: "flat", chrome: "page" } }, collie).map((f) => f.check);
    expect(flat).toEqual(plain);
  });

  it.each(["gradient", "grain"] as const)("measures the page's text again on the %s ground's other end", (ground) => {
    const report = contrastReport({ ...collie, version: 2, surface: { ground } }, collie);
    const checks = report.filter((f) => f.check.endsWith(`the ${ground} ground`)).map((f) => `${f.half} ${f.check}`);
    expect(checks).toContain(`light foreground on the ${ground} ground`);
    expect(checks).toContain(`dark muted-foreground on the ${ground} ground`);
    expect(checks).toContain(`dark status-blocked chip on the ${ground} ground`);
    expect(checks).toContain(`light rule on the ${ground} ground`);
    expect(checks).toHaveLength(2 * 11);
  });

  it("measures on the oklab mix index.css draws: the gradient's 12 percent of primary", () => {
    const theme: Theme = { ...collie, version: 2, surface: { ground: "gradient" } };
    const report = contrastReport(theme, collie);
    const end = mixOklab(collie.dark?.background ?? "", collie.dark?.primary ?? "", 12);
    const f = report.find((r) => r.half === "dark" && r.check === "foreground on the gradient ground");
    expect(f?.ratio).toBe(Math.round(contrast(collie.dark?.foreground ?? "", end) * 100) / 100);
  });

  it("fails a gradient whose bottom end loses the text", () => {
    const dark = { ...collie.dark, background: "#000000", primary: "#ffffff", foreground: "#767676" };
    const report = contrastReport({ ...collie, version: 2, dark, surface: { ground: "gradient" } }, collie);
    expect(report.find((f) => f.half === "dark" && f.check === "foreground on background")?.pass).toBe(true);
    expect(report.find((f) => f.half === "dark" && f.check === "foreground on the gradient ground")?.pass).toBe(false);
  });

  it("measures the band's text on secondary under `chrome: band`", () => {
    const report = contrastReport({ ...collie, version: 2, surface: { chrome: "band" } }, collie);
    const band = report.filter((f) => f.check.endsWith("on the band"));
    expect(band.map((f) => `${f.half} ${f.check}`)).toEqual([
      "light foreground on the band",
      "light muted-foreground on the band",
      "light status-blocked on the band",
      "dark foreground on the band",
      "dark muted-foreground on the band",
      "dark status-blocked on the band",
    ]);
    expect(band.find((f) => f.half === "light" && f.check === "foreground on the band")?.ratio).toBe(
      Math.round(contrast(collie.light?.foreground ?? "", collie.light?.secondary ?? "") * 100) / 100,
    );
  });
});

// ── Schema version 3: the optional tokens (pane-active) ───────────────────────────

describe("the optional tokens", () => {
  const collie = parseTheme(read("src/themes/collie.json"), { ...CAP, allowReservedId: true });
  if (!collie.ok) throw new Error("collie.json does not parse");
  const base = collie.theme;

  it("are appended after the 43, so the order of every earlier file holds", () => {
    expect(OPTIONAL_THEME_TOKENS).toEqual(["pane-active"]);
    expect(ALL_THEME_TOKENS.slice(0, 43)).toEqual([...THEME_TOKENS]);
    expect(ALL_THEME_TOKENS).toHaveLength(44);
  });

  it("are read from a version 3 file, and the theme is handed back as version 3", () => {
    const result = parseTheme(file({ version: 3, light: { "pane-active": "#336699" } }), CAP);
    expect(result.ok && result.theme.light?.["pane-active"]).toBe("#336699");
    expect(result.ok && versionOf(result.theme)).toBe(3);
  });

  it("are refused in a file that says version 1 or 2, by name and with the version they need", () => {
    for (const version of [1, 2]) {
      const result = parseTheme(file({ version, dark: { "pane-active": "#336699" } }), CAP);
      expect(codes(result)).toEqual(["version dark.pane-active"]);
    }
  });

  it("refuse a value that is not a colour, like any other token", () => {
    const result = parseTheme(file({ version: 3, light: { "pane-active": "grey" } }), CAP);
    expect(codes(result)).toEqual(["value light.pane-active"]);
  });

  // OLD FILES. A file written before version 3 (the shipped version 1 and 2 shapes) must read and
  // export exactly as it did: the same theme, the same lowest version, and the same text again.
  it.each([
    ["version 1, colours only", { version: 1, id: "old1", name: "Old", light: { background: "#ffffff", foreground: "#111111" } }, 1],
    [
      "version 2, with a surface block and a display face",
      { version: 2, id: "old2", name: "Old", dark: { background: "#000000" }, surface: { radius: "soft" }, fonts: { display: "grotesk" } },
      2,
    ],
  ] as const)("round-trips an old %s file unchanged and sets neither optional token", (_name, doc, version) => {
    const raw = JSON.stringify(doc);
    const first = parseTheme(raw, CAP);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.theme.version).toBe(version);
    expect(versionOf(first.theme)).toBe(version);
    for (const token of OPTIONAL_THEME_TOKENS) {
      expect(setsOptionalToken(first.theme, token)).toBe(false);
      expect(first.theme.light?.[token]).toBeUndefined();
      expect(first.theme.dark?.[token]).toBeUndefined();
    }
    // Export (what the picker writes) and parse again: the same theme.
    const exported = JSON.stringify({ ...first.theme, version: versionOf(first.theme) }, null, 2);
    const second = parseTheme(exported, CAP);
    expect(second.ok && second.theme).toEqual(first.theme);
    if (!second.ok) return;
    expect(JSON.stringify({ ...second.theme, version: versionOf(second.theme) }, null, 2)).toBe(exported);
  });

  it("leaves an old theme's filled halves and contrast report as they were", () => {
    const old = parseTheme(file({ light: { background: "#ffffff" } }), CAP);
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const filled = fillHalves(old.theme, base);
    for (const token of OPTIONAL_THEME_TOKENS) expect(filled.light[token]).toBe(base.light?.[token]);
    expect(contrastReport(old.theme, base).some((f) => f.check.startsWith("pane-active"))).toBe(false);
  });

  it("measures an optional token only in a half that sets it", () => {
    const theme: Theme = { version: 3, id: "a", name: "A", light: { "pane-active": "#fafafa" } };
    const checks = contrastReport(theme, base).filter((f) => f.check.startsWith("pane-active"));
    expect(checks.map((f) => `${f.half} ${f.check} ${f.pass}`).toSorted()).toEqual([
      "light pane-active on background false",
    ]);
  });
});

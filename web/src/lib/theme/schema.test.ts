import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/json";
import { SHIPPED_MARKS } from "@/lib/shipped-marks";

import {
  SHIPPED_THEME_IDS,
  THEME_TOKENS,
  THEME_VERSION,
  contrast,
  contrastReport,
  fillHalves,
  isColour,
  lightDark,
  markOf,
  parseTheme,
  toSrgbHex,
  type ParsedTheme,
  type Refusal,
  type Theme,
} from "./schema";

const CAP = { maxBytes: 64 * 1024 };

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
    expect(THEME_VERSION).toBe(1);
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
    const r = refusals(parseTheme(file({ version: 2 }), CAP));
    expect(r.map((x) => x.code)).toEqual(["version"]);
    expect(r[0]?.detail).toContain("version 2");
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
      version: 3,
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

describe("the mark", () => {
  it.each(SHIPPED_MARKS)("accepts the shipped mark %s", (mark) => {
    const result = parseTheme(file({ mark }), CAP);
    expect(result.ok && result.theme.mark).toBe(mark);
    expect(result.ok && markOf(result.theme)).toBe(mark);
  });

  it("resolves a file without a mark to the collie mark", () => {
    const result = parseTheme(file({}), CAP);
    if (!result.ok) throw new Error("the plain file is refused");
    expect("mark" in result.theme).toBe(false);
    expect(markOf(result.theme)).toBe("collie");
  });

  it.each([["owl"], ["Collie"], [""], [1], [null], [{ id: "collie" }], [["collie"]]])(
    "refuses the mark %j and names the value",
    (mark) => {
      const found = refusals(parseTheme(file({ mark }), CAP));
      expect(found.map((r) => `${r.code} ${r.path}`)).toEqual(["mark mark"]);
      expect(found[0]?.detail).toContain(JSON.stringify(mark));
      expect(found[0]?.detail).toContain(SHIPPED_MARKS.join(", "));
    },
  );

  it("cuts a long refused mark in the message", () => {
    const found = refusals(parseTheme(file({ mark: "x".repeat(500) }), CAP));
    expect(found[0]?.code).toBe("mark");
    expect((found[0]?.detail ?? "").length).toBeLessThan(200);
  });

  it("keeps the mark on a round trip, and adds no key when there is none", () => {
    const once = parseTheme(file({ mark: "harbour" }), CAP);
    if (!once.ok) throw new Error("refused");
    const twice = parseTheme(JSON.stringify(once.theme), CAP);
    expect(twice).toEqual(once);
    const plain = parseTheme(file({}), CAP);
    expect(plain.ok && JSON.stringify(plain.theme)).not.toContain("mark");
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
        destructive: "#ffffff",
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

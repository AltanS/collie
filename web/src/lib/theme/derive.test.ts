import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { generateThemes } from "../../../e2e/themes/generate";
import {
  contrast,
  formatColour,
  rgbToLab,
  DERIVED_TOKENS,
  deriveTokens,
  distance,
  HOVER_FLOOR,
  parseColour,
  PLANE_GAP,
  PLANES,
  RING_FLOOR,
  STATE_FLOOR,
  TEXT_FLOOR,
  withLightness,
  type DerivedHalf,
  type Lab,
} from "./derive";
import { fillHalves, isColour, parseTheme, type Half, type Theme } from "./schema";

const read = (id: string): Theme => {
  const parsed = parseTheme(readFileSync(resolve(__dirname, `../../themes/${id}.json`), "utf8"), { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error(`${id} does not parse`);
  return parsed.theme;
};
const COLLIE = read("collie");
const filled = (t: Theme) => fillHalves(t, COLLIE);

// THE REFERENCE: Collie through the function is Collie as painted. Collie's base tokens are read from
// `src/themes/collie.json`, which `src/themes/themes.test.ts` holds equal to index.css's `:root`, token by token; the
// relations derive.ts mirrors are held to index.css's own lines below, so the stylesheet cannot move alone. The planes
// are the colours the themes set read off the screen on 2026-11-21 (e2e/themes/collie-states.json, "plane recess" and
// "plane paper"); the state fills are the tokens Collie's stylesheet points them at. Held within 0.005 in OKLab (the
// worst is 0.0021, the dark recess), well inside the 0.02 of Altan's approval.
const REFERENCE_TOLERANCE = 0.005;
const PAINTED = {
  light: { "surface-recess": "#e1dfdd", "surface-paper": "#ffffff" },
  dark: { "surface-recess": "#060605", "surface-paper": "#1d1c1b" },
} as const;

describe("Collie is the reference", () => {
  for (const half of ["light", "dark"] as const) {
    it(`${half}: every derived token is Collie's own value, within 0.02`, () => {
      const tokens = filled(COLLIE)[half];
      const page = parseColour(tokens.background ?? "");
      const token = (name: keyof Half) => parseColour(tokens[name] ?? "", page);
      const derived = deriveTokens(tokens, half);
      const at = (name: keyof DerivedHalf) => parseColour(derived[name]);
      const paper = parseColour(PAINTED[half]["surface-paper"]);
      const expected = {
        "surface-recess": parseColour(PAINTED[half]["surface-recess"]),
        "surface-paper": paper,
        "state-hover-page": token("accent"),
        "state-hover-recess": paper,
        "state-hover-paper": token("accent"),
        "state-on-page": token("accent"),
        "state-on-recess": paper,
        "state-on-paper": token("accent"),
        "state-open-page": token("control-on"),
        "state-open-recess": token("control-on"),
        "state-open-paper": token("control-on"),
        ring: token("ring"),
      } satisfies Record<keyof DerivedHalf, Lab>;
      for (const name of DERIVED_TOKENS) expect(distance(at(name), expected[name]), `${half} ${name}`).toBeLessThanOrEqual(REFERENCE_TOLERANCE);
    });
  }
});

describe("index.css holds the relations derive.ts mirrors", () => {
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
  // One line each, as written: a change to any of them is a change to derive.ts's relation too (and to its golden values).
  for (const line of [
    "--surface-recess: oklch(from var(--background) calc(l - 0.05) c h);",
    "--surface-paper: light-dark(oklch(from var(--card) min(1, calc(l + 0.05)) c h), color-mix(in oklch, var(--background), oklch(from var(--card) calc(l + 0.05) c h)));",
    "--state-hover-page: var(--accent);",
    "--state-hover-recess: var(--surface-paper);",
    "--state-hover-paper: var(--accent);",
    "--state-on-page: var(--accent);",
    "--state-on-recess: var(--surface-paper);",
    "--state-on-paper: var(--accent);",
    "--state-open-page: var(--control-on);",
    "--state-open-recess: var(--control-on);",
    "--state-open-paper: var(--control-on);",
  ]) {
    it(line.slice(0, line.indexOf(":")), () => {
      expect(css).toContain(`  ${line}\n`);
    });
  }
});

/** Every floor of one derived half, as the list of the ones that fail. */
function brokenFloors(tokens: Half, d: DerivedHalf): string[] {
  const page = parseColour(tokens.background ?? "");
  const token = (name: keyof Half) => parseColour(tokens[name] ?? "", page);
  const at = (name: keyof DerivedHalf) => parseColour(d[name]);
  const ground = { page, recess: at("surface-recess"), paper: at("surface-paper") };
  const out: string[] = [];
  const muted = token("muted-foreground");
  for (const plane of ["recess", "paper"] as const) {
    const floor = Math.min(TEXT_FLOOR, contrast(muted, page)) - 0.01;
    if (contrast(muted, ground[plane]) < floor) out.push(`muted ink on the ${plane} ${contrast(muted, ground[plane]).toFixed(2)}`);
    // The gap gives way to the ink, and is only sought on the plane's own side of the page: it may be short only when
    // no lightness on that side both meets it and keeps the inks (a white page has no lighter paper).
    // The recess may stand on either side; the paper keeps its own.
    const side = Math.sign(ground[plane][0] - page[0]) || 1;
    const gapCanHold = Array.from({ length: 401 }, (_, i) => withLightness(ground[plane], i / 400))
      .filter((c) => plane === "recess" || Math.sign(c[0] - page[0]) === side)
      // A plane keeps the page's side of the ink (derive.ts, inkHolds).
      .filter((c) => Math.sign(c[0] - token("foreground")[0]) === Math.sign(page[0] - token("foreground")[0]) && Math.sign(c[0] - muted[0]) === Math.sign(page[0] - muted[0]))
      .some(
        (c) =>
          // With the margin a pushed plane is given (derive.ts, MARGIN).
          distance(c, page) >= PLANE_GAP + 0.006 &&
          contrast(muted, c) >= Math.min(TEXT_FLOOR + 0.1, contrast(muted, page)) &&
          contrast(token("foreground"), c) >= Math.min(TEXT_FLOOR + 0.1, contrast(token("foreground"), page)),
      );
    // A paper that cannot stand off the page on its own side sits on it (Daylight's white page): the focus frame marks it.
    const onPage = plane === "paper" && distance(ground[plane], page) < 0.005;
    if (gapCanHold && !onPage && distance(ground[plane], page) < PLANE_GAP - 1e-3) out.push(`${plane} ${distance(ground[plane], page).toFixed(3)} off the page`);
  }
  for (const plane of PLANES) {
    const g = ground[plane];
    const hover = distance(at(`state-hover-${plane}`), g);
    const on = distance(at(`state-on-${plane}`), g);
    const open = distance(at(`state-open-${plane}`), g);
    if (hover < HOVER_FLOOR - 1e-3) out.push(`hover on the ${plane} ${hover.toFixed(3)}`);
    if (on < STATE_FLOOR - 1e-3) out.push(`selected on the ${plane} ${on.toFixed(3)}`);
    if (open < STATE_FLOOR - 1e-3) out.push(`open on the ${plane} ${open.toFixed(3)}`);
  }
  const ring = at("ring");
  for (const [name, g] of [
    ["page", page],
    ["card", token("card")],
    ["recess", ground.recess],
    ["paper", ground.paper],
    ["band", token("secondary")],
    ["muted", token("muted")],
    ...PLANES.flatMap((plane) => [
      [`hover on the ${plane}`, at(`state-hover-${plane}`)] as const,
      [`selected on the ${plane}`, at(`state-on-${plane}`)] as const,
    ]),
  ] as const) {
    if (contrast(ring, g) < RING_FLOOR - 0.01) out.push(`ring on the ${name} ${contrast(ring, g).toFixed(2)}`);
  }
  return out;
}

describe("no derived state falls under its floor", () => {
  const looks: [string, Theme][] = [
    ["nightwatch", read("nightwatch")],
    ["daylight", read("daylight")],
    ["harbour", read("harbour")],
    ...generateThemes().themes.map((g, i): [string, Theme] => [`gen-${String(i + 1)}-${g.profile}`, g.theme]),
  ];
  for (const [id, theme] of looks) {
    it(id, () => {
      const f = filled(theme);
      for (const half of ["light", "dark"] as const) expect(brokenFloors(f[half], deriveTokens(f[half], half)), `${id} ${half}`).toEqual([]);
    });
  }
});

describe("a ground at each end of the lightness range", () => {
  const ends: [string, Partial<Half>, "light" | "dark"][] = [
    ["a white page", { background: "oklch(1 0 0)", card: "oklch(1 0 0)", accent: "oklch(1 0 0)", ring: "oklch(0.98 0 0)", "control-on": "oklch(1 0 0)" }, "light"],
    ["a black page", { background: "oklch(0 0 0)", card: "oklch(0 0 0)", accent: "oklch(0 0 0)", ring: "oklch(0.05 0 0)", "control-on": "oklch(0 0 0)" }, "dark"],
    ["a dark light half", { background: "oklch(0.12 0 0)", card: "oklch(0.16 0 0)", foreground: "oklch(0.97 0 0)", "muted-foreground": "oklch(0.78 0 0)", accent: "oklch(0.14 0 0)" }, "light"],
  ];
  for (const [name, over, half] of ends) {
    it(name, () => {
      const tokens: Half = { ...filled(COLLIE)[half], ...over };
      expect(brokenFloors(tokens, deriveTokens(tokens, half))).toEqual([]);
    });
  }
});

describe("one grammar, finite numbers", () => {
  it("reads white at lightness 1 (Ottosson's coefficients, none truncated)", () => {
    expect(Math.abs(rgbToLab([1, 1, 1])[0] - 1)).toBeLessThan(1e-6);
  });

  it("refuses what the schema refuses, and reads what it reads", () => {
    for (const bad of ["oklch(1.2.3 0 0)", "oklch(0.5 0.1)", "#abc", "rgb(0 0 0)", "oklch(2 0 0)", "oklch(0.5 0.1 20 / 2)", "var(--x)"]) {
      expect(isColour(bad), bad).toBe(false);
      expect(() => parseColour(bad), bad).toThrow(/not a theme colour/u);
    }
    for (const good of ["#a1b2c3", "#a1b2c380", "oklch(0.5 0.1 20)", "oklch(.5 0.1 20 / 50%)", "OKLCH( 0.5 0.1 20 )"]) {
      expect(isColour(good), good).toBe(true);
      expect(parseColour(good, [0.5, 0, 0]).every((x) => Number.isFinite(x)), good).toBe(true);
    }
  });

  it("refuses to write a colour that is not finite", () => {
    expect(() => formatColour([Number.NaN, 0, 0])).toThrow(/not a finite colour/u);
  });
});

/** A small seeded generator (mulberry32), so the fuzz is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("a few thousand random halves", () => {
  it("never throws, and every derived value is finite and a colour the schema accepts", () => {
    const rand = seeded(172);
    // SAFETY: the index is below the length of a list that is never empty.
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const n = (x: number) => String(Math.round(x * 1000) / 1000);
    const colour = (): string => {
      const L = pick([0, 1, rand(), rand(), rand() * 0.1, 1 - rand() * 0.1]);
      const C = pick([0, rand() * 0.05, rand() * 0.37]);
      const H = rand() * 360;
      const alpha = pick([undefined, undefined, undefined, rand()]);
      if (rand() < 0.3) {
        const byte = () => Math.floor(rand() * 256).toString(16).padStart(2, "0");
        return `#${byte()}${byte()}${byte()}${alpha === undefined ? "" : byte()}`;
      }
      return alpha === undefined ? `oklch(${n(L)} ${n(C)} ${n(H)})` : `oklch(${n(L)} ${n(C)} ${n(H)} / ${n(alpha)})`;
    };
    const keys = ["background", "card", "foreground", "muted-foreground", "accent", "control-on", "control-on-foreground", "ring", "secondary", "muted", "surface-recess", "surface-paper"] as const;
    let halves = 0;
    for (let i = 0; i < 1500; i += 1) {
      for (const half of ["light", "dark"] as const) {
        const tokens: Half = { ...filled(COLLIE)[half] };
        for (const key of keys) if (key === "background" || rand() < 0.7) tokens[key] = colour();
        // The edge cases on purpose: the page as the card, the ink as the page.
        if (i % 7 === 0) tokens.card = tokens.background;
        if (i % 11 === 0) tokens.foreground = tokens.background;
        if (i % 13 === 0) tokens["muted-foreground"] = tokens.background;
        if (rand() < 0.5) delete tokens["surface-recess"];
        if (rand() < 0.5) delete tokens["surface-paper"];
        const out = deriveTokens(tokens, half);
        for (const token of DERIVED_TOKENS) expect(isColour(out[token]), `${token} = ${out[token]}`).toBe(true);
        halves += 1;
      }
    }
    expect(halves).toBe(3000);
  }, 120_000);
});

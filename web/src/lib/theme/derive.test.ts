import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { generateThemes } from "../../../e2e/themes/generate";
import {
  contrast,
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
import { fillHalves, parseTheme, type Half, type Theme } from "./schema";

const read = (id: string): Theme => {
  const parsed = parseTheme(readFileSync(resolve(__dirname, `../../themes/${id}.json`), "utf8"), { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error(`${id} does not parse`);
  return parsed.theme;
};
const COLLIE = read("collie");
const filled = (t: Theme) => fillHalves(t, COLLIE);

// THE REFERENCE: Collie through the function is Collie as painted. The planes are the colours the themes set read
// off the screen on 2026-11-21 (e2e/themes/collie-states.json, "plane recess" and "plane paper"); the state fills
// are the tokens Collie's stylesheet points them at. Held within 0.02 in OKLab, the hold of Altan's approval.
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
      for (const name of DERIVED_TOKENS) expect(distance(at(name), expected[name]), `${half} ${name}`).toBeLessThanOrEqual(0.02);
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

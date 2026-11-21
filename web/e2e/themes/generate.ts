import { contrast as tokenContrast, parseTheme, type Half, type Theme, type ThemeToken } from "@/lib/theme/schema";

// THEMES NOBODY HAS SEEN. R5 holds the bundled looks, but a person can paste any file the schema takes, and a rule
// that only the four shipped themes pass proves nothing about the fifth. This makes valid themes inside what the
// schema allows, seeded, so a run repeats exactly: each profile is one corner a community theme lands in. Every
// theme it returns has passed `parseTheme`, the same parser an import goes through; a profile whose draw the parser
// refuses draws again with the next seed, and the refusal is counted (`refusedDraws`), because a theme the schema
// refuses never reaches a screen.

/** The seven colour tokens of a theme ported from another app's palette: a ground, two inks, a raised surface, an accent and its ink, an edge. */
export const SEVEN_TOKENS = ["background", "foreground", "card", "primary", "primary-foreground", "accent", "border"] as const satisfies readonly ThemeToken[];

export type Profile =
  | "low-contrast"
  | "mid-grey"
  | "saturated-accent"
  | "light-dark-accent"
  | "dark-light-accent"
  | "seven-tokens"
  | "inverted-halves"
  | "flat"
  | "saturated-ground"
  | "random";

export interface Generated {
  theme: Theme;
  profile: Profile;
  /** The half the set wears it in: the half this profile is about. */
  scheme: "light" | "dark";
  /** The seed it was drawn with, after any redraws. */
  seed: number;
}

/** mulberry32: a small seeded generator, so the same seed gives the same theme on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const f3 = (n: number) => String(Math.round(n * 1000) / 1000);
/** An `oklch()` value the schema takes: plain numbers, L 0..1, C 0..0.5, H 0..360. */
const ok = (l: number, c: number, h: number) => `oklch(${f3(clamp(l, 0, 1))} ${f3(clamp(c, 0, 0.5))} ${f3(((h % 360) + 360) % 360)})`;

/** The ink of the two that reads best on a ground: near-black or near-white. */
function inkOn(ground: string, hue: number): string {
  const dark = ok(0.15, 0.01, hue);
  const light = ok(0.98, 0.005, hue);
  return tokenContrast(dark, ground) >= tokenContrast(light, ground) ? dark : light;
}

/** The lightness of an ink at about `target`:1 against a ground of lightness `bgL`, found by walking away from the ground. */
function inkAt(bgL: number, hue: number, chroma: number, target: number, darker: boolean): string {
  const ground = ok(bgL, chroma, hue);
  for (let step = 0; step <= 100; step += 1) {
    const l = darker ? bgL - step / 100 : bgL + step / 100;
    if (l < 0 || l > 1) break;
    const c = ok(l, chroma, hue);
    if (tokenContrast(c, ground) >= target) return c;
  }
  return darker ? ok(0, 0, hue) : ok(1, 0, hue);
}

interface HalfRecipe {
  /** Is this half a light ground? */
  light: boolean;
  bgL: number;
  bgC: number;
  hue: number;
  /** The ratio of `foreground` on `background`. */
  fgRatio: number;
  /** How far `muted-foreground` sits toward the ground, as a ratio of its own. */
  mutedRatio: number;
  /** The step of the raised and the inert surfaces off the ground, in OKLCH L. */
  step: number;
  /** The step of the hover/current row (`accent`) off the ground. */
  accentStep: number;
  /** The line steps. */
  borderStep: number;
  ruleStep: number;
  /** The accent colour: `primary`, `ring`, `control-on`, as L C H. */
  accent: [number, number, number];
  /** Set `accent` (the row token) to this L instead of a step off the ground. */
  accentRowL?: number;
}

const HOSTS = ["host-0", "host-1", "host-2", "host-3", "host-4", "host-5", "host-6", "host-7", "host-8", "host-9"] as const satisfies readonly ThemeToken[];

/** A full half of 43 tokens from a recipe. */
function half(s: HalfRecipe): Half {
  const up = s.light ? -1 : 1; // the direction "raised" takes: lighter in dark, darker in light (inert and lines)
  const bg = ok(s.bgL, s.bgC, s.hue);
  const fg = inkAt(s.bgL, s.hue, Math.min(0.02, s.bgC), s.fgRatio, s.light);
  const muted = inkAt(s.bgL, s.hue, Math.min(0.03, s.bgC), s.mutedRatio, s.light);
  const [aL, aC, aH] = s.accent;
  const primary = ok(aL, aC, aH);
  const cardL = s.light ? Math.min(1, s.bgL + s.step) : s.bgL + s.step;
  const accentRow = s.accentRowL === undefined ? ok(s.bgL + up * s.accentStep, s.bgC, s.hue) : ok(s.accentRowL, Math.min(0.06, s.bgC + 0.02), s.hue);
  const controlOn = s.light ? ok(Math.max(s.bgL - 0.07, 0.6), Math.min(aC, 0.08), aH) : ok(s.bgL + 0.15, Math.min(aC, 0.07), aH);
  const statusL = s.light ? 0.5 : 0.76;
  const h: Half = {
    background: bg,
    foreground: fg,
    card: ok(cardL, s.bgC, s.hue),
    "card-foreground": fg,
    chrome: ok(s.bgL + up * s.step, s.bgC, s.hue),
    primary,
    "primary-foreground": inkOn(primary, aH),
    "control-on": controlOn,
    "control-on-foreground": inkAt(Number(controlOn.split(" ")[0]!.slice(6)), aH, Math.min(aC, 0.12), 6, s.light),
    secondary: ok(s.bgL + up * s.step, s.bgC, s.hue),
    "secondary-foreground": fg,
    muted: ok(s.bgL + up * s.step, s.bgC, s.hue),
    "muted-foreground": muted,
    accent: accentRow,
    "accent-foreground": inkOn(accentRow, s.hue),
    destructive: ok(s.light ? 0.52 : 0.7, 0.2, 27),
    "destructive-foreground": s.light ? ok(0.98, 0, 0) : ok(0.15, 0, 0),
    border: ok(s.bgL + up * s.borderStep, s.bgC, s.hue),
    input: ok(s.bgL + up * (s.borderStep + 0.15), s.bgC, s.hue),
    rule: ok(s.bgL + up * s.ruleStep, s.bgC, s.hue),
    ring: ok(aL, aC, aH),
    "status-blocked": ok(statusL, 0.19, 25),
    "status-working": ok(statusL + 0.04, 0.15, 75),
    "status-done": ok(statusL, 0.15, 150),
    "status-idle": ok(statusL, 0.02, s.hue),
    "status-unknown": ok(statusL, 0.08, 280),
    "status-info": ok(statusL, 0.13, 240),
    "syntax-keyword": ok(statusL, 0.18, 350),
    "syntax-string": ok(statusL, 0.12, 250),
    "syntax-constant": ok(statusL, 0.12, 55),
    "syntax-property": ok(statusL, 0.09, 200),
    "syntax-entity": ok(statusL, 0.15, 300),
    "syntax-comment": ok(statusL, 0.01, s.hue),
  };
  for (const [i, token] of HOSTS.entries()) h[token] = ok(statusL, 0.14, i * 36 + 10);
  return h;
}

function lightRecipe(r: () => number, over: Partial<HalfRecipe> = {}): HalfRecipe {
  const hue = r() * 360;
  return {
    light: true,
    bgL: 0.93 + r() * 0.06,
    bgC: r() * 0.02,
    hue,
    fgRatio: 9 + r() * 8,
    mutedRatio: 4.6 + r() * 2,
    step: 0.02 + r() * 0.05,
    accentStep: 0.04 + r() * 0.05,
    borderStep: 0.08 + r() * 0.08,
    ruleStep: 0.18 + r() * 0.1,
    accent: [0.45 + r() * 0.15, 0.08 + r() * 0.12, r() * 360],
    ...over,
  };
}

function darkRecipe(r: () => number, over: Partial<HalfRecipe> = {}): HalfRecipe {
  const hue = r() * 360;
  return {
    light: false,
    bgL: 0.1 + r() * 0.12,
    bgC: r() * 0.025,
    hue,
    fgRatio: 9 + r() * 8,
    mutedRatio: 4.6 + r() * 2,
    step: 0.03 + r() * 0.07,
    accentStep: 0.06 + r() * 0.08,
    borderStep: 0.15 + r() * 0.12,
    ruleStep: 0.25 + r() * 0.12,
    accent: [0.7 + r() * 0.15, 0.08 + r() * 0.12, r() * 360],
    ...over,
  };
}

function only(h: Half, tokens: readonly ThemeToken[]): Half {
  const out: Half = {};
  for (const t of tokens) if (h[t] !== undefined) out[t] = h[t];
  return out;
}

const SURFACES = [
  { radius: "sharp", chrome: "band" },
  { radius: "soft", chrome: "page", rows: "cards" },
  { radius: "round", chrome: "page", ground: "flat" },
  { radius: "sharp", chrome: "page", tabs: "folder" },
] as const;

/** A theme file as a person would paste it, before the parser reads it. */
interface ThemeFile {
  version: 2;
  id: string;
  name: string;
  surface: (typeof SURFACES)[number];
  light: Half;
  dark: Half;
}

/** One draw: the file, and the half it is about. */
interface Draw {
  file: ThemeFile;
  scheme: "light" | "dark";
}

/** One draw of a profile. The schema may still refuse it (a low-contrast draw can land under 3:1). */
function draw(profile: Profile, seed: number): Draw {
  const r = rng(seed);
  const surface = SURFACES[Math.floor(r() * SURFACES.length)]!;
  const base = { version: 2 as const, id: `gen-${profile}-${String(seed)}`, name: `Generated ${profile} ${String(seed)}`, surface };
  switch (profile) {
    case "low-contrast": {
      // Inks that pass the schema's hard floor of 3 and stay under the report's 4.5, and quiet lines.
      const scheme = r() < 0.5 ? "light" : "dark";
      const lo = { fgRatio: 3.1 + r() * 1.3, mutedRatio: 3 + r() * 0.6, borderStep: 0.03 + r() * 0.03, ruleStep: 0.06 + r() * 0.04, accentStep: 0.02 + r() * 0.02 };
      return { file: { ...base, light: half(lightRecipe(r, scheme === "light" ? lo : {})), dark: half(darkRecipe(r, scheme === "dark" ? lo : {})) }, scheme };
    }
    case "mid-grey": {
      // A ground in the middle, where neither "a step lighter" nor "a step darker" is obviously the raised one.
      const light = r() < 0.5;
      const recipe: Partial<HalfRecipe> = { light, bgL: 0.5 + r() * 0.12, bgC: r() * 0.01, fgRatio: 4.6 + r() * 3, mutedRatio: 3.2 + r() * 1.5, accent: [light ? 0.3 : 0.85, 0.1, r() * 360] };
      const scheme = light ? "light" : "dark";
      return { file: { ...base, light: half(lightRecipe(r, light ? recipe : {})), dark: half(darkRecipe(r, light ? {} : recipe)) }, scheme };
    }
    case "saturated-accent": {
      const scheme = r() < 0.5 ? "light" : "dark";
      const hue = r() * 360;
      const accent: [number, number, number] = [scheme === "light" ? 0.55 : 0.7, 0.3 + r() * 0.07, hue];
      return { file: { ...base, light: half(lightRecipe(r, { accent })), dark: half(darkRecipe(r, { accent })) }, scheme };
    }
    case "light-dark-accent": {
      // A light theme whose accent row and primary are dark: the ink on them must flip.
      const recipe = lightRecipe(r, { accent: [0.25 + r() * 0.1, 0.1 + r() * 0.1, r() * 360], accentRowL: 0.3 + r() * 0.1 });
      return { file: { ...base, light: half(recipe), dark: half(darkRecipe(r)) }, scheme: "light" };
    }
    case "dark-light-accent": {
      const recipe = darkRecipe(r, { accent: [0.85 + r() * 0.1, 0.1 + r() * 0.1, r() * 360], accentRowL: 0.82 + r() * 0.1 });
      return { file: { ...base, light: half(lightRecipe(r)), dark: half(recipe) }, scheme: "dark" };
    }
    case "seven-tokens": {
      // A port of another app's palette: seven tokens in each half, everything else Collie's own.
      const scheme = r() < 0.5 ? "light" : "dark";
      const hue = r() * 360;
      const lightHalf = only(half(lightRecipe(r, { hue, bgC: 0.02 + r() * 0.04 })), SEVEN_TOKENS);
      const darkHalf = only(half(darkRecipe(r, { hue, bgC: 0.02 + r() * 0.04 })), SEVEN_TOKENS);
      return { file: { ...base, light: lightHalf, dark: darkHalf }, scheme };
    }
    case "inverted-halves": {
      // The schema lets the "light" half be dark and the "dark" half light. A `dark:` class then picks the wrong side.
      const scheme = r() < 0.5 ? "light" : "dark";
      return { file: { ...base, light: half(darkRecipe(r)), dark: half(lightRecipe(r)) }, scheme };
    }
    case "flat": {
      // One surface for everything: card, muted, accent and the lines a hair off the ground.
      const scheme = r() < 0.5 ? "light" : "dark";
      const flat = { step: 0, accentStep: 0.01, borderStep: 0.02, ruleStep: 0.04 };
      return { file: { ...base, light: half(lightRecipe(r, scheme === "light" ? flat : {})), dark: half(darkRecipe(r, scheme === "dark" ? flat : {})) }, scheme };
    }
    case "saturated-ground": {
      const scheme = r() < 0.5 ? "light" : "dark";
      const sat = scheme === "light" ? { bgL: 0.88 + r() * 0.05, bgC: 0.06 + r() * 0.05 } : { bgL: 0.22 + r() * 0.1, bgC: 0.1 + r() * 0.08 };
      return { file: { ...base, light: half(lightRecipe(r, scheme === "light" ? sat : {})), dark: half(darkRecipe(r, scheme === "dark" ? sat : {})) }, scheme };
    }
    case "random": {
      const scheme = r() < 0.5 ? "light" : "dark";
      return { file: { ...base, light: half(lightRecipe(r)), dark: half(darkRecipe(r)) }, scheme };
    }
  }
}

/** Each profile and how many themes it draws: 24 in all. */
export const PLAN: readonly [Profile, number][] = [
  ["low-contrast", 3],
  ["mid-grey", 3],
  ["saturated-accent", 2],
  ["light-dark-accent", 2],
  ["dark-light-accent", 2],
  ["seven-tokens", 3],
  ["inverted-halves", 2],
  ["flat", 2],
  ["saturated-ground", 2],
  ["random", 3],
];

/** The first seed; a theme's seed is this plus its place in the plan, plus 1000 for each redraw. */
export const SEED = 20261121;

/** A draw the parser refused, and why. */
export interface RefusedDraw {
  profile: Profile;
  seed: number;
  why: string;
}

/** The generated set: the themes the parser took, and the draws it refused on the way. */
export interface GeneratedSet {
  themes: Generated[];
  refusedDraws: RefusedDraw[];
}

export function generateThemes(): GeneratedSet {
  const themes: Generated[] = [];
  const refusedDraws: RefusedDraw[] = [];
  let place = 0;
  for (const [profile, n] of PLAN) {
    for (let i = 0; i < n; i += 1, place += 1) {
      for (let redraw = 0; ; redraw += 1) {
        if (redraw > 20) throw new Error(`the ${profile} profile drew 20 themes the schema refused`);
        const seed = SEED + place + redraw * 1000;
        const { file, scheme } = draw(profile, seed);
        const parsed = parseTheme(JSON.stringify(file), { maxBytes: 64 * 1024 });
        if (!parsed.ok) {
          refusedDraws.push({ profile, seed, why: parsed.refusals.map((x) => x.detail).join(" ") });
          continue;
        }
        themes.push({ theme: parsed.theme, profile, scheme, seed });
        break;
      }
    }
  }
  return { themes, refusedDraws };
}

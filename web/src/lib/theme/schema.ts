// A theme file, version 1: the schema, the one parser, and the colour arithmetic the contrast
// report needs (M57, the shared contract in the milestone README).
//
// WHAT A THEME IS. One JSON file with an id, a name, two halves of named colour tokens (light and
// dark) and an optional bundled UI face. Nothing else: no radius, no spacing, no raw CSS, no remote
// font. The token list below is CLOSED, and the parser refuses any key it does not name, so a file
// can never smuggle a property into the page.
//
// WHY THE PARSER IS TOTAL AND COLLECTS. A person imports a file someone else wrote. Telling them
// about the first problem and hiding the next nine makes them fix a file nine more times. So
// `parseTheme` never throws, walks the whole document, and returns every refusal it found, each with
// the path it is about and a sentence Settings can show as it is.
//
// WHY THIS FILE IMPORTS SO LITTLE. It loads without a DOM, without React and without the `@/` alias,
// because `scripts/build-themes.ts` at the collie root imports it, and the bridge may validate an
// operator theme with it later. Its two imports are leaf files with no imports of their own.

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonObject } from "../json";
import { SHIPPED_FONTS } from "../shipped-fonts";

/** The schema version this build reads. A file with any other `version` is refused. */
export const THEME_VERSION = 1;

/**
 * The closed token list, in the order `index.css` declares them. Each name is a CSS custom
 * property (`--<name>`) written as one `light-dark()` pair. `popover` is an alias of `card` in
 * index.css and is not a token; the ANSI slots and `radius` are not themable at all.
 */
export const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "chrome",
  "primary",
  "primary-foreground",
  "control-on",
  "control-on-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "rule",
  "ring",
  "status-blocked",
  "status-working",
  "status-done",
  "status-idle",
  "status-unknown",
  "status-info",
  "syntax-keyword",
  "syntax-string",
  "syntax-constant",
  "syntax-property",
  "syntax-entity",
  "syntax-comment",
  "host-0",
  "host-1",
  "host-2",
  "host-3",
  "host-4",
  "host-5",
  "host-6",
  "host-7",
  "host-8",
  "host-9",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** The shipped ids. An imported file may not use one, so a download can never replace a shipped look. */
export const SHIPPED_THEME_IDS = ["collie", "nightwatch", "daylight", "harbour"] as const;

export type ShippedThemeId = (typeof SHIPPED_THEME_IDS)[number];

/** The theme that is the app's own look, and the one every missing token is filled from. */
export const DEFAULT_THEME_ID: ShippedThemeId = "collie";

/**
 * One half of a theme: a value per token it sets, already normalised (trimmed, lower case, single
 * spaces). An interface rather than an alias so it names its owner: the keys are the closed list.
 */
export interface Half extends Partial<Record<ThemeToken, string>> {}

export interface Theme {
  version: 1;
  id: string;
  name: string;
  author?: string;
  light?: Half;
  dark?: Half;
  fonts?: { ui: string };
}

export type RefusalCode =
  | "size"
  | "json"
  | "version"
  | "id"
  | "name"
  | "author"
  | "unknown-key"
  | "value"
  | "font"
  | "no-half"
  | "reserved-id";

/**
 * Why a file was refused. `path` is where (`$` for the whole file, `dark.status-blocked`,
 * `fonts.ui`), and `detail` is the cause in plain words, the line Settings shows.
 */
export interface Refusal {
  code: RefusalCode;
  path: string;
  detail: string;
}

export type ParsedTheme = { ok: true; theme: Theme } | { ok: false; refusals: Refusal[] };

export interface ParseThemeOptions {
  /** The size cap, checked on the UTF-8 byte length before anything is parsed. */
  maxBytes: number;
  /**
   * Accept a shipped id. Only `scripts/build-themes.ts` sets it, for the shipped files themselves.
   * An import never does, so a downloaded file with a shipped id is refused.
   */
  allowReservedId?: boolean;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_MAX = 40;
const AUTHOR_MAX = 60;
const TOP_KEYS = ["$schema", "version", "id", "name", "author", "light", "dark", "fonts"] as const;
const HALVES = ["light", "dark"] as const;

export function isThemeToken(value: string): value is ThemeToken {
  return THEME_TOKENS.some((token) => token === value);
}

/** True for a string shaped like a theme id. Says nothing about whether such a theme exists. */
export function isThemeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isShippedThemeId(value: string): value is ShippedThemeId {
  return SHIPPED_THEME_IDS.some((id) => id === value);
}

function isTopKey(value: string): boolean {
  return TOP_KEYS.some((key) => key === value);
}

/** A string's length in characters as a person counts them (code points, not UTF-16 units). */
function charCount(value: string): number {
  return [...value].length;
}

/**
 * Parse an untrusted theme file. Total: any string gives a theme or a non-empty list of refusals,
 * and every refusal in the file is collected, not only the first.
 */
export function parseTheme(raw: string, opts: ParseThemeOptions): ParsedTheme {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > opts.maxBytes) {
    return refuse([
      {
        code: "size",
        path: "$",
        detail: `The file is ${bytes} bytes. A theme may be at most ${opts.maxBytes} bytes.`,
      },
    ]);
  }
  const doc = parseJsonObject(raw);
  if (doc === undefined) {
    return refuse([{ code: "json", path: "$", detail: "The file is not a JSON object." }]);
  }

  const refusals: Refusal[] = [];
  for (const key of Object.keys(doc)) {
    if (!isTopKey(key)) refusals.push(unknownKey(key));
  }

  const version = asJsonNumber(doc.version);
  if (version !== THEME_VERSION) {
    refusals.push({
      code: "version",
      path: "version",
      detail:
        doc.version === undefined
          ? `The file has no version. This Collie reads version ${THEME_VERSION}.`
          : `The file is version ${JSON.stringify(doc.version)}. This Collie reads version ${THEME_VERSION}.`,
    });
  }

  const id = readId(doc, opts, refusals);
  const name = readName(doc, refusals);
  const author = readAuthor(doc, refusals);
  const light = readHalf(doc, "light", refusals);
  const dark = readHalf(doc, "dark", refusals);
  const fonts = readFonts(doc, refusals);

  if (countTokens(light) + countTokens(dark) === 0 && !hasHalfRefusal(refusals)) {
    refusals.push({
      code: "no-half",
      path: "$",
      detail: "The file sets no colour. Give it a light half, a dark half, or both.",
    });
  }

  if (refusals.length > 0 || id === undefined || name === undefined) return refuse(refusals);

  const theme: Theme = { version: THEME_VERSION, id, name };
  // Assigned, never spread: an absent field must carry NO key, so an export round-trips to the
  // same text the person imported.
  if (author !== undefined) theme.author = author;
  if (countTokens(light) > 0) theme.light = light;
  if (countTokens(dark) > 0) theme.dark = dark;
  if (fonts !== undefined) theme.fonts = fonts;
  return { ok: true, theme };
}

function refuse(refusals: Refusal[]): ParsedTheme {
  return { ok: false, refusals };
}

function unknownKey(path: string): Refusal {
  return {
    code: "unknown-key",
    path,
    detail: `"${path}" is not part of a theme file. Remove it.`,
  };
}

function readId(doc: JsonObject, opts: ParseThemeOptions, refusals: Refusal[]): string | undefined {
  const id = asJsonString(doc.id);
  if (id === undefined || !ID_PATTERN.test(id)) {
    refusals.push({
      code: "id",
      path: "id",
      detail:
        "The id must be 1 to 32 characters of lower-case letters, digits and hyphens, and start with a letter or a digit.",
    });
    return undefined;
  }
  if (isShippedThemeId(id) && opts.allowReservedId !== true) {
    refusals.push({
      code: "reserved-id",
      path: "id",
      detail: `The id "${id}" belongs to a theme that ships with Collie. Give the file an id of its own.`,
    });
    return undefined;
  }
  return id;
}

function readName(doc: JsonObject, refusals: Refusal[]): string | undefined {
  const name = asJsonString(doc.name)?.trim();
  if (name === undefined || name === "" || charCount(name) > NAME_MAX) {
    refusals.push({
      code: "name",
      path: "name",
      detail: `The name must be text of 1 to ${NAME_MAX} characters.`,
    });
    return undefined;
  }
  return name;
}

function readAuthor(doc: JsonObject, refusals: Refusal[]): string | undefined {
  if (doc.author === undefined) return undefined;
  const author = asJsonString(doc.author)?.trim();
  if (author === undefined || charCount(author) > AUTHOR_MAX) {
    refusals.push({
      code: "author",
      path: "author",
      detail: `The author must be text of at most ${AUTHOR_MAX} characters.`,
    });
    return undefined;
  }
  return author === "" ? undefined : author;
}

function readHalf(doc: JsonObject, which: (typeof HALVES)[number], refusals: Refusal[]): Half {
  const half: Half = {};
  const value = doc[which];
  if (value === undefined) return half;
  const obj = asJsonObject(value);
  if (obj === undefined) {
    refusals.push({
      code: "value",
      path: which,
      detail: `"${which}" must be an object of colour tokens.`,
    });
    return half;
  }
  for (const key of Object.keys(obj)) {
    const path = `${which}.${key}`;
    if (!isThemeToken(key)) {
      refusals.push(unknownKey(path));
      continue;
    }
    const raw = asJsonString(obj[key]);
    const colour = raw === undefined ? undefined : normaliseColour(raw);
    if (colour === undefined) {
      refusals.push({
        code: "value",
        path,
        detail: `"${path}" is not a colour. Use #rrggbb, #rrggbbaa, oklch(L C H) or oklch(L C H / A).`,
      });
      continue;
    }
    half[key] = colour;
  }
  return half;
}

function readFonts(doc: JsonObject, refusals: Refusal[]): { ui: string } | undefined {
  if (doc.fonts === undefined) return undefined;
  const fonts = asJsonObject(doc.fonts);
  if (fonts === undefined) {
    refusals.push({ code: "font", path: "fonts", detail: '"fonts" must be an object with one key, "ui".' });
    return undefined;
  }
  for (const key of Object.keys(fonts)) {
    if (key !== "ui") refusals.push(unknownKey(`fonts.${key}`));
  }
  if (fonts.ui === undefined) return undefined;
  const ui = asJsonString(fonts.ui);
  const shipped = SHIPPED_FONTS.find((font) => font === ui);
  if (shipped === undefined) {
    refusals.push({
      code: "font",
      path: "fonts.ui",
      detail: `"fonts.ui" must be one of the faces Collie ships: ${SHIPPED_FONTS.join(", ")}.`,
    });
    return undefined;
  }
  return { ui: shipped };
}

function countTokens(half: Half): number {
  return Object.keys(half).length;
}

/** A refused half (wrong type, unknown key, bad value) already says what is wrong with the colours. */
function hasHalfRefusal(refusals: readonly Refusal[]): boolean {
  return refusals.some((r) => HALVES.some((h) => r.path === h || r.path.startsWith(`${h}.`)));
}

// ── The colour grammar ────────────────────────────────────────────────────────────────────────
//
// Two forms and nothing else: hex with six or eight digits, and oklch with plain numbers. Every
// other CSS colour function, every keyword, `var()`, `url()`, and anything that could close the
// declaration (`;`, `}`) fails the patterns below, which are anchored at both ends. The length cap
// runs first so a huge string costs one comparison, not a regex walk.

export const COLOUR_MAX = 64;
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/;
const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const OKLCH = new RegExp(String.raw`^oklch\( ?${NUM} ${NUM} ${NUM}(?: / ${NUM}(%)?)? ?\)$`);

/**
 * The two forms as ONE regex source, for `public/theme-init.js`, which cannot import this file and
 * spells the same pattern as a literal. `src/theme-init.test.ts` reads both and fails on drift. It
 * checks the shape of a normalised value only; the ranges (L up to 1, C up to 0.5, H up to 360) are
 * `parseTheme`'s, and a stored value has already passed them.
 */
export const COLOUR_SOURCE = String.raw`^(?:#(?:[0-9a-f]{6}|[0-9a-f]{8})|oklch\( ?(?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+) (?:\d+(?:\.\d+)?|\.\d+)(?: / (?:\d+(?:\.\d+)?|\.\d+)%?)? ?\))$`;

interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

/** The canonical spelling of a colour, or `undefined` when the value is not one. */
function normaliseColour(value: string): string | undefined {
  if (value.length > COLOUR_MAX) return undefined;
  const text = value.trim().toLowerCase().replaceAll(/\s+/g, " ");
  if (HEX.test(text)) return text;
  if (readOklch(text) === undefined) return undefined;
  return text.replace("( ", "(").replace(" )", ")");
}

function readOklch(text: string): Oklch | undefined {
  const m = OKLCH.exec(text);
  if (m === null) return undefined;
  const l = Number(m[1]);
  const c = Number(m[2]);
  const h = Number(m[3]);
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] === "%" ? 100 : 1);
  if (l > 1 || c > 0.5 || h > 360 || a > 1) return undefined;
  return { l, c, h, alpha: a };
}

/** True for a value the grammar accepts: `#rrggbb`, `#rrggbbaa`, `oklch(L C H)`, `oklch(L C H / A)`. */
export function isColour(value: string): boolean {
  return normaliseColour(value) !== undefined;
}

// ── Colour arithmetic ─────────────────────────────────────────────────────────────────────────
//
// oklch to oklab is polar to Cartesian; oklab to linear sRGB is Björn Ottosson's published pair of
// matrices; linear to sRGB is the standard transfer curve. Channels are clamped into gamut and
// rounded to 8 bits, because that is what the browser paints and what index.css measured.

interface Rgba {
  /** sRGB channels, gamma encoded, 0 to 255 after rounding. */
  r: number;
  g: number;
  b: number;
  alpha: number;
}

function oklabToLinear(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function encode(linear: number): number {
  const x = Math.min(1, Math.max(0, linear));
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

function decode(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toRgba(value: string): Rgba | undefined {
  const text = normaliseColour(value);
  if (text === undefined) return undefined;
  if (text.startsWith("#")) {
    const n = (i: number) => Number.parseInt(text.slice(i, i + 2), 16);
    return { r: n(1), g: n(3), b: n(5), alpha: text.length === 9 ? n(7) / 255 : 1 };
  }
  const o = readOklch(text);
  if (o === undefined) return undefined;
  const rad = (o.h * Math.PI) / 180;
  const [r, g, b] = oklabToLinear(o.l, o.c * Math.cos(rad), o.c * Math.sin(rad));
  return { r: encode(r), g: encode(g), b: encode(b), alpha: o.alpha };
}

function toOklab(value: string): [number, number, number] | undefined {
  const c = toRgba(value);
  if (c === undefined) return undefined;
  return linearToOklab(decode(c.r), decode(c.g), decode(c.b));
}

function hex2(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

/**
 * `#rrggbb` for any accepted colour, alpha dropped. `undefined` is never returned for a value
 * `isColour` accepts; anything else gives `#000000`.
 */
export function toSrgbHex(value: string): string {
  const c = toRgba(value) ?? { r: 0, g: 0, b: 0, alpha: 1 };
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** `top` laid over `ground` with plain sRGB alpha. The ground is taken as opaque. */
function over(top: Rgba, ground: Rgba, alpha: number): Rgba {
  const mix = (t: number, g: number) => Math.round(t * alpha + g * (1 - alpha));
  return { r: mix(top.r, ground.r), g: mix(top.g, ground.g), b: mix(top.b, ground.b), alpha: 1 };
}

function luminance(c: Rgba): number {
  return 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b);
}

function ratio(ink: Rgba, ground: Rgba): number {
  const a = luminance(ink);
  const b = luminance(ground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The WCAG 2 contrast ratio of `a` drawn over `b`, in sRGB. A translucent `a` is first laid over
 * `b` (that is what the page shows); `b` is taken as opaque. A value that is not a colour has no
 * contrast, so the result is 1.
 */
export function contrast(a: string, b: string): number {
  const ink = toRgba(a);
  const ground = toRgba(b);
  if (ink === undefined || ground === undefined) return 1;
  return ratio(ink.alpha < 1 ? over(ink, ground, ink.alpha) : ink, ground);
}

// ── Filling and writing ───────────────────────────────────────────────────────────────────────

/** Both halves complete enough to write: every token the theme leaves out comes from `base`. */
export interface FilledHalves {
  light: Half;
  dark: Half;
}

/** Fill each half token by token: the theme's value first, then the base theme's. */
export function fillHalves(theme: Theme, base: Theme): FilledHalves {
  const light: Half = {};
  const dark: Half = {};
  for (const token of THEME_TOKENS) {
    const l = theme.light?.[token] ?? base.light?.[token];
    const d = theme.dark?.[token] ?? base.dark?.[token];
    if (l !== undefined) light[token] = l;
    if (d !== undefined) dark[token] = d;
  }
  return { light, dark };
}

/**
 * The `light-dark(<l>, <d>)` value of one token. Throws when either half lacks it, which can only
 * happen when the base theme itself is incomplete: a build error, not a user's.
 */
export function lightDark(filled: FilledHalves, token: ThemeToken): string {
  const l = filled.light[token];
  const d = filled.dark[token];
  if (l === undefined || d === undefined) throw new Error(`theme token "${token}" has no value in both halves`);
  return `light-dark(${l}, ${d})`;
}

// ── The contrast report ───────────────────────────────────────────────────────────────────────

export interface Finding {
  half: "light" | "dark";
  check: string;
  ratio: number;
  floor: number;
  pass: boolean;
}

const TEXT_FLOOR = 4.5;
const RULE_FLOOR = 1.3;
const CHIP_ALPHA = 0.15;
/** The least oklab distance between `status-blocked` and `status-done`, so the two never look alike. */
const BLOCKED_DONE_FLOOR = 0.15;

const STATUS_TOKENS = [
  "status-blocked",
  "status-working",
  "status-done",
  "status-idle",
  "status-unknown",
  "status-info",
] as const;

const TEXT_PAIRS: ReadonlyArray<readonly [ThemeToken, ThemeToken]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
];

const CHIP_GROUNDS = ["background", "card"] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Measure a theme against the floors the app holds itself to, in both halves, after filling the
 * missing tokens from `base`. A chip is the status ink over the status at 15 percent laid over the
 * ground, in plain sRGB alpha: index.css records that this is within 0.08 of the browser's oklab mix
 * and always on the pessimistic side.
 */
export function contrastReport(theme: Theme, base: Theme): Finding[] {
  const filled = fillHalves(theme, base);
  const findings: Finding[] = [];
  for (const half of HALVES) {
    const values = filled[half];
    const rgba = (token: ThemeToken) => toRgba(values[token] ?? "");
    const push = (check: string, value: number, floor: number) =>
      findings.push({ half, check, ratio: round2(value), floor, pass: value >= floor });

    for (const [ink, ground] of TEXT_PAIRS) {
      push(`${ink} on ${ground}`, contrast(values[ink] ?? "", values[ground] ?? ""), TEXT_FLOOR);
    }
    for (const status of STATUS_TOKENS) {
      const ink = rgba(status);
      for (const groundToken of CHIP_GROUNDS) {
        const ground = rgba(groundToken);
        const value =
          ink === undefined || ground === undefined
            ? 1
            : ratio(over(ink, ground, ink.alpha), over(ink, ground, CHIP_ALPHA * ink.alpha));
        push(`${status} chip on ${groundToken}`, value, TEXT_FLOOR);
      }
    }
    push("rule on background", contrast(values.rule ?? "", values.background ?? ""), RULE_FLOOR);

    const blocked = toOklab(values["status-blocked"] ?? "");
    const done = toOklab(values["status-done"] ?? "");
    const distance =
      blocked === undefined || done === undefined
        ? 0
        : Math.hypot(blocked[0] - done[0], blocked[1] - done[1], blocked[2] - done[2]);
    push("status-blocked apart from status-done", distance, BLOCKED_DONE_FLOOR);
  }
  return findings;
}

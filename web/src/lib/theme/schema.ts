// A theme file, versions 1, 2 and 3: the schema, the one parser, and the colour arithmetic the contrast
// report needs (M57, the shared contract in the milestone README).
//
// WHAT A THEME IS. One JSON file with an id, a name, two halves of named colour tokens (light and
// dark), an optional bundled UI face, and from version 2 an optional `surface` block of shape words
// (`surface.ts`), an optional display face (`fonts.display`) and an optional terminal palette (`ansi`). Nothing else: no free radius or spacing value, no raw CSS, no remote font. The
// token list and the word lists are CLOSED, and the parser refuses any key or word it does not name,
// so a file can never smuggle a property into the page.
//
// VERSIONS. The parser reads 1, 2 and 3 and hands back the LOWEST version that holds the content: 3
// when the theme sets the optional token (`pane-active`), else 2 when it carries
// a surface block, a display face or a palette, else 1. So a colour-only theme is stored and
// exported as version 1, and a Collie from before version 2 (1.21.x after a rollback) still reads it.
// A version 1 file has no surface block, which means the default word for every shape token. A
// `surface` block, a `fonts.display` or an `ansi` block in a file that says version 1 is refused: the
// file is older than the block. An optional token in a file that says version 1 or 2 is refused the
// same way. Every file written before version 3 reads and exports exactly as it did.
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
import {
  ANSI_KEYS,
  GROUND_GRADIENT_END,
  GROUND_GRAIN_LINE,
  SURFACE_TOKENS,
  isSurfaceToken,
  resolveSurface,
  surfaceWordOf,
  surfaceWords,
  type Ansi,
  type AnsiKey,
  type Surface,
  type SurfaceToken,
} from "./surface";

/** The highest schema version this build reads and writes. Only a theme that sets an optional token needs it. */
export const THEME_VERSION = 3;

/** The schema versions this build reads. A file with any other `version` is refused. */
export const THEME_VERSIONS_READ = [1, 2, 3] as const;

export type ThemeVersion = (typeof THEME_VERSIONS_READ)[number];

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

/**
 * The token added in schema version 3. Unlike the 43 above a theme may leave it out, and then the
 * `:root` pair in index.css holds, so a file written before version 3 paints as it always did. A
 * component reads it as `border-pane-active` (the frame of the active pane column on a large
 * screen). It is appended after the list above, so no earlier file or order moves.
 */
export const OPTIONAL_THEME_TOKENS = ["pane-active"] as const;

export type OptionalThemeToken = (typeof OPTIONAL_THEME_TOKENS)[number];

/** Every token a half may name: the 43, then the optional ones. */
export const ALL_THEME_TOKENS = [...THEME_TOKENS, ...OPTIONAL_THEME_TOKENS] as const;

export type AnyThemeToken = ThemeToken | OptionalThemeToken;

/** The shipped ids. An imported file may not use one, so a download can never replace a shipped look. */
export const SHIPPED_THEME_IDS = ["collie", "nightwatch", "daylight", "harbour"] as const;

export type ShippedThemeId = (typeof SHIPPED_THEME_IDS)[number];

/** The theme that is the app's own look, and the one every missing token is filled from. */
export const DEFAULT_THEME_ID: ShippedThemeId = "collie";

/**
 * One half of a theme: a value per token it sets, already normalised (trimmed, lower case, single
 * spaces). An interface rather than an alias so it names its owner: the keys are the closed list.
 */
export interface Half extends Partial<Record<AnyThemeToken, string>> {}

export interface Theme {
  /** The lowest version that holds the content: 2 with a `surface` block, 1 without (`versionOf`). */
  version: ThemeVersion;
  id: string;
  name: string;
  author?: string;
  light?: Half;
  dark?: Half;
  /** The UI face, and from version 2 the display face for titles. Each one of the shipped faces. */
  fonts?: ThemeFonts;
  /** Version 2: the shape words the file names. Absent, or a token left out, is the default word. */
  surface?: Surface;
  /** Version 2: the terminal palette, all eighteen colours, dark-space and gate-checked. */
  ansi?: Ansi;
}

/** A theme's faces. Either may be absent; an empty `fonts` object carries no key. */
export interface ThemeFonts {
  ui?: string;
  display?: string;
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
  | "reserved-id"
  | "surface"
  | "ansi";

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
const TOP_KEYS = ["$schema", "version", "id", "name", "author", "light", "dark", "fonts", "surface", "ansi"] as const;
const HALVES = ["light", "dark"] as const;

export function isThemeToken(value: string): value is ThemeToken {
  return THEME_TOKENS.some((token) => token === value);
}

export function isOptionalThemeToken(value: string): value is OptionalThemeToken {
  return OPTIONAL_THEME_TOKENS.some((token) => token === value);
}

/** True when the theme names this optional token in either half. A theme that does not leaves the stylesheet's pair alone. */
export function setsOptionalToken(theme: Theme, token: OptionalThemeToken): boolean {
  return theme.light?.[token] !== undefined || theme.dark?.[token] !== undefined;
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

  const version = readVersion(doc, refusals);

  const id = readId(doc, opts, refusals);
  const name = readName(doc, refusals);
  const author = readAuthor(doc, refusals);
  const light = readHalf(doc, "light", version, refusals);
  const dark = readHalf(doc, "dark", version, refusals);
  const fonts = readFonts(doc, version, refusals);
  const surface = readSurface(doc, version, refusals);
  const ansi = readAnsi(doc, version, refusals);

  if (countTokens(light) + countTokens(dark) === 0 && !hasHalfRefusal(refusals)) {
    refusals.push({
      code: "no-half",
      path: "$",
      detail: "The file sets no colour. Give it a light half, a dark half, or both.",
    });
  }

  if (refusals.length > 0 || id === undefined || name === undefined) return refuse(refusals);

  const theme: Theme = { version: 1, id, name };
  // Assigned, never spread: an absent field must carry NO key, so an export round-trips to the
  // same text the person imported.
  if (author !== undefined) theme.author = author;
  if (countTokens(light) > 0) theme.light = light;
  if (countTokens(dark) > 0) theme.dark = dark;
  if (fonts !== undefined) theme.fonts = fonts;
  if (surface !== undefined) theme.surface = surface;
  if (ansi !== undefined) theme.ansi = ansi;
  theme.version = versionOf(theme);
  return { ok: true, theme };
}

/**
 * The most refusals a result lists. A file with thousands of unknown keys must not become thousands
 * of rows in Settings: the first ones say what is wrong, and one last row counts the rest.
 */
const MAX_REFUSALS = 25;

function refuse(refusals: Refusal[]): ParsedTheme {
  if (refusals.length <= MAX_REFUSALS) return { ok: false, refusals };
  const rest = refusals.length - MAX_REFUSALS;
  return {
    ok: false,
    refusals: [...refusals.slice(0, MAX_REFUSALS), { code: "json", path: "$", detail: `and ${rest} more` }],
  };
}

/**
 * True when the text holds a control character: below U+0020, U+007F, or the C1 range U+0080 to
 * U+009F. A name or an author is shown in Settings and written into an export, and a line break or
 * a NUL there is never what the author meant.
 */
function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function unknownKey(path: string): Refusal {
  return {
    code: "unknown-key",
    path,
    detail: `"${path}" is not part of a theme file. Remove it.`,
  };
}

const READ_TEXT = `${THEME_VERSIONS_READ.slice(0, -1).join(", ")} and ${THEME_VERSIONS_READ.at(-1)}`;

/** The version a theme is written as: 3 with an optional token, 2 with a shape, a display face or a palette, else 1. */
export function versionOf(theme: Theme): ThemeVersion {
  if (OPTIONAL_THEME_TOKENS.some((token) => setsOptionalToken(theme, token))) return 3;
  return theme.surface === undefined && theme.ansi === undefined && theme.fonts?.display === undefined ? 1 : 2;
}

/** The refusal of a version 2 block in a file that says version 1. */
function olderThanBlock(block: string): Refusal {
  return {
    code: "version",
    path: "version",
    detail: `A file with ${block} must say version 2. This one says version 1.`,
  };
}

function readVersion(doc: JsonObject, refusals: Refusal[]): ThemeVersion | undefined {
  const value = asJsonNumber(doc.version);
  const version = THEME_VERSIONS_READ.find((v) => v === value);
  if (version !== undefined) return version;
  refusals.push({
    code: "version",
    path: "version",
    detail:
      doc.version === undefined
        ? `The file has no version. This Collie reads version ${READ_TEXT}.`
        : `The file is version ${JSON.stringify(doc.version)}. This Collie reads version ${READ_TEXT}.`,
  });
  return undefined;
}

/**
 * The `surface` block: one closed word per shape token. An unknown token is an unknown key, a word
 * outside the token's list (a number included) names the token and its words, and a block in a
 * version 1 file is refused, because version 1 has no such block. An empty block carries no key.
 */
function readSurface(doc: JsonObject, version: ThemeVersion | undefined, refusals: Refusal[]): Surface | undefined {
  if (doc.surface === undefined) return undefined;
  if (version === 1) refusals.push(olderThanBlock('a "surface" block'));
  const block = asJsonObject(doc.surface);
  if (block === undefined) {
    refusals.push({
      code: "surface",
      path: "surface",
      detail: `"surface" must be an object with a word for any of: ${SURFACE_TOKENS.join(", ")}.`,
    });
    return undefined;
  }
  const surface: Surface = {};
  for (const key of Object.keys(block)) {
    const path = `surface.${key}`;
    if (!isSurfaceToken(key)) {
      refusals.push(unknownKey(path));
      continue;
    }
    // A number, a list or an object is no word: `asJsonString` gives `undefined` and the token is refused.
    if (!setSurfaceWord(surface, key, asJsonString(block[key]))) {
      refusals.push({
        code: "surface",
        path,
        detail: `"${path}" must be one of: ${surfaceWords(key).join(", ")}.`,
      });
    }
  }
  return Object.keys(surface).length === 0 ? undefined : surface;
}

/** Put `value` into `surface` as the word of `token` when it is one. False when it is not. */
function setSurfaceWord(surface: Surface, token: SurfaceToken, value: string | undefined): boolean {
  switch (token) {
    case "radius":
      surface.radius = surfaceWordOf("radius", value);
      return surface.radius !== undefined;
    case "shadow":
      surface.shadow = surfaceWordOf("shadow", value);
      return surface.shadow !== undefined;
    case "density":
      surface.density = surfaceWordOf("density", value);
      return surface.density !== undefined;
    case "weight":
      surface.weight = surfaceWordOf("weight", value);
      return surface.weight !== undefined;
    case "border":
      surface.border = surfaceWordOf("border", value);
      return surface.border !== undefined;
    case "ground":
      surface.ground = surfaceWordOf("ground", value);
      return surface.ground !== undefined;
    case "chrome":
      surface.chrome = surfaceWordOf("chrome", value);
      return surface.chrome !== undefined;
    case "rows":
      surface.rows = surfaceWordOf("rows", value);
      return surface.rows !== undefined;
    case "icons":
      surface.icons = surfaceWordOf("icons", value);
      return surface.icons !== undefined;
    case "labels":
      surface.labels = surfaceWordOf("labels", value);
      return surface.labels !== undefined;
  }
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
  if (hasControlCharacter(name)) {
    refusals.push({ code: "name", path: "name", detail: "The name holds a control character. Remove it." });
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
  if (hasControlCharacter(author)) {
    refusals.push({ code: "author", path: "author", detail: "The author holds a control character. Remove it." });
    return undefined;
  }
  return author === "" ? undefined : author;
}

function readHalf(
  doc: JsonObject,
  which: (typeof HALVES)[number],
  version: ThemeVersion | undefined,
  refusals: Refusal[],
): Half {
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
    if (!isThemeToken(key) && !isOptionalThemeToken(key)) {
      refusals.push(unknownKey(path));
      continue;
    }
    // An optional token is older than any file that says version 1 or 2: the file is refused, as a
    // surface block in a version 1 file is, and the value is still read so its own fault shows too.
    if (isOptionalThemeToken(key) && version !== undefined && version < 3) {
      refusals.push({
        code: "version",
        path,
        detail: `A file with "${key}" must say version 3. This one says version ${version}.`,
      });
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

function readFonts(doc: JsonObject, version: ThemeVersion | undefined, refusals: Refusal[]): ThemeFonts | undefined {
  if (doc.fonts === undefined) return undefined;
  const fonts = asJsonObject(doc.fonts);
  if (fonts === undefined) {
    refusals.push({ code: "font", path: "fonts", detail: '"fonts" must be an object with the keys "ui" and "display".' });
    return undefined;
  }
  for (const key of Object.keys(fonts)) {
    if (key !== "ui" && key !== "display") refusals.push(unknownKey(`fonts.${key}`));
  }
  const out: ThemeFonts = {};
  const ui = readFace(fonts, "ui", refusals);
  if (ui !== undefined) out.ui = ui;
  if (fonts.display !== undefined && version === 1) refusals.push(olderThanBlock('a "fonts.display" face'));
  const display = readFace(fonts, "display", refusals);
  if (display !== undefined) out.display = display;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** One face of the `fonts` object: absent, or one of the shipped faces. Anything else is refused with its path. */
function readFace(fonts: JsonObject, key: "ui" | "display", refusals: Refusal[]): string | undefined {
  if (fonts[key] === undefined) return undefined;
  const value = asJsonString(fonts[key]);
  const shipped = SHIPPED_FONTS.find((font) => font === value);
  if (shipped === undefined) {
    refusals.push({
      code: "font",
      path: `fonts.${key}`,
      detail: `"fonts.${key}" must be one of the faces Collie ships: ${SHIPPED_FONTS.join(", ")}.`,
    });
    return undefined;
  }
  return shipped;
}

// ── The terminal palette (M57 spec 17) ────────────────────────────────────────────────────────
//
// THE GATE, AND WHY EACH PART. The palette replaces the mirror's sixteen slots and its own ink and
// ground (`--ansi-0..15`, `--mirror-ink`, `--mirror-ground`). It is authored in dark space, like
// index.css's own palette, because light inverts the mirror wholesale (.adr/0002). A colour that
// fails is refused, never warned about: an agent's output is the thing a person reads most, and a
// slot nobody can see is a lost line, not a style.
//   * all eighteen or none: half a palette would mix two palettes in one pane;
//   * opaque: a translucent slot would change with whatever it is laid over;
//   * ink on ground at 4.5:1, the text floor, and the ground darker than the ink (dark space);
//   * slots 1 to 7 and 9 to 15 at 3:1 on the ground, the floor for a colour that must be seen. Slot 0
//     is black, the colour a terminal draws as "no colour", and is exempt; slot 8 is checked;
//   * the bright set. The Muse decorator (lib/harness/muse/display.ts) treats slots 3, 7, 11 and 15 as
//     the bright foregrounds, the ones it darkens on a light native mirror, by a fixed list held against
//     index.css's palette at relative luminance {@link ANSI_BRIGHT_LUMINANCE}. A theme's palette must
//     keep that list true: those four above the line, every other slot at or below it.

/** The relative luminance line of the bright set: `BRIGHT_FG_LUMINANCE` in muse/display.ts, held equal by a test. */
export const ANSI_BRIGHT_LUMINANCE = 0.6;
/** The slots that must sit above the line; every other slot must not. */
export const ANSI_BRIGHT_SLOTS: readonly AnsiKey[] = ["3", "7", "11", "15"];
const ANSI_SLOT_FLOOR = 3;

function readAnsi(doc: JsonObject, version: ThemeVersion | undefined, refusals: Refusal[]): Ansi | undefined {
  if (doc.ansi === undefined) return undefined;
  if (version === 1) refusals.push(olderThanBlock('an "ansi" block'));
  const block = asJsonObject(doc.ansi);
  if (block === undefined) {
    refusals.push({
      code: "ansi",
      path: "ansi",
      detail: `"ansi" must be an object with a colour for each of: ${ANSI_KEYS.join(", ")}.`,
    });
    return undefined;
  }
  for (const key of Object.keys(block)) {
    if (!ANSI_KEYS.some((k) => k === key)) refusals.push(unknownKey(`ansi.${key}`));
  }
  const missing = ANSI_KEYS.filter((key) => block[key] === undefined);
  if (missing.length > 0) {
    refusals.push({
      code: "ansi",
      path: "ansi",
      detail: `"ansi" must hold all ${ANSI_KEYS.length} colours or none. It lacks: ${missing.join(", ")}.`,
    });
  }
  const values: Partial<Record<AnsiKey, Rgba>> = {};
  const texts: Partial<Ansi> = {};
  let valid = true;
  for (const key of ANSI_KEYS) {
    if (block[key] === undefined) continue;
    const raw = asJsonString(block[key]);
    const text = raw === undefined ? undefined : normaliseColour(raw);
    const rgba = text === undefined ? undefined : toRgba(text);
    if (text === undefined || rgba === undefined) {
      refusals.push({
        code: "ansi",
        path: `ansi.${key}`,
        detail: `"ansi.${key}" is not a colour. Use #rrggbb or oklch(L C H).`,
      });
      valid = false;
      continue;
    }
    if (rgba.alpha < 1) {
      refusals.push({ code: "ansi", path: `ansi.${key}`, detail: `"ansi.${key}" must be opaque, with no alpha.` });
      valid = false;
      continue;
    }
    values[key] = rgba;
    texts[key] = text;
  }
  if (missing.length > 0 || !valid) return undefined;
  const ansi = completeAnsi(texts);
  const ground = values.ground;
  const ink = values.ink;
  if (ansi === undefined || ground === undefined || ink === undefined) return undefined;

  const before = refusals.length;
  const inkRatio = ratio(ink, ground);
  if (inkRatio < TEXT_FLOOR) {
    refusals.push({
      code: "ansi",
      path: "ansi.ink",
      detail: `"ansi.ink" on "ansi.ground" measures ${round2(inkRatio)}. The floor is ${TEXT_FLOOR}.`,
    });
  }
  if (luminance(ground) >= luminance(ink)) {
    refusals.push({
      code: "ansi",
      path: "ansi.ground",
      detail: '"ansi.ground" must be darker than "ansi.ink": the mirror is drawn in dark space.',
    });
  }
  for (const key of ANSI_KEYS) {
    if (key === "ink" || key === "ground") continue;
    const slot = values[key];
    if (slot === undefined) continue;
    const r = ratio(slot, ground);
    if (key !== "0" && r < ANSI_SLOT_FLOOR) {
      refusals.push({
        code: "ansi",
        path: `ansi.${key}`,
        detail: `"ansi.${key}" on "ansi.ground" measures ${round2(r)}. The floor is ${ANSI_SLOT_FLOOR}.`,
      });
    }
    const bright = ANSI_BRIGHT_SLOTS.includes(key);
    const lum = luminance(slot);
    if (bright && lum <= ANSI_BRIGHT_LUMINANCE) {
      refusals.push({
        code: "ansi",
        path: `ansi.${key}`,
        detail: `"ansi.${key}" is a bright slot and needs a relative luminance above ${ANSI_BRIGHT_LUMINANCE}. It has ${round2(lum)}.`,
      });
    }
    if (!bright && lum > ANSI_BRIGHT_LUMINANCE) {
      refusals.push({
        code: "ansi",
        path: `ansi.${key}`,
        detail: `"ansi.${key}" must have a relative luminance of ${ANSI_BRIGHT_LUMINANCE} or less; only slots ${ANSI_BRIGHT_SLOTS.join(", ")} are bright. It has ${round2(lum)}.`,
      });
    }
  }
  return refusals.length === before ? ansi : undefined;
}

/** The palette when every key has its value, else `undefined`. */
function completeAnsi(texts: Partial<Ansi>): Ansi | undefined {
  const out: Partial<Ansi> = {};
  for (const key of ANSI_KEYS) {
    const value = texts[key];
    if (value === undefined) return undefined;
    out[key] = value;
  }
  // SAFETY: the loop above returned unless every one of the eighteen keys holds a value.
  return out as Ansi;
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

/**
 * `color-mix(in oklab, <base> <100 - percent>%, <mix>)` of two accepted colours, as the opaque sRGB
 * hex the browser paints: each colour to oklab, a straight line between them, back to sRGB. Alpha is
 * dropped, as the ground colours it serves are opaque. A value that is not a colour gives `#000000`.
 */
export function mixOklab(base: string, mix: string, percent: number): string {
  const a = toOklab(base);
  const b = toOklab(mix);
  if (a === undefined || b === undefined) return "#000000";
  const t = percent / 100;
  const [r, g, bl] = oklabToLinear(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  return `#${hex2(encode(r))}${hex2(encode(g))}${hex2(encode(bl))}`;
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
  // The optional tokens are filled too, and a token neither side names is simply absent.
  for (const token of ALL_THEME_TOKENS) {
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
export function lightDark(filled: FilledHalves, token: AnyThemeToken): string {
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
/** WCAG 1.4.11, for a colour that only draws a shape: the destructive icon. */
const NON_TEXT_FLOOR = 3;
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
    // THE COUNSEL PAIRS (M57 spec 12, 2026-10-16). Colours the app also draws as TEXT or as an
    // urgent mark, which the pairs above did not reach. `text-destructive` is text in the action
    // sheet rows and the ask card; `text-status-blocked` is the urgent countdown in the cache chip.
    //   * destructive on the page and on a card is held at 3:1 as the icon colour, and at 4.5:1 as
    //     text. Collie's own light `destructive` on `background` is 4.38, a known value of the look the
    //     app always had (it does not change). A theme that keeps both colours of a pair as the
    //     base has them is held to what the base measures, so the default and an untouched export
    //     do not warn, and never below 3; any theme that moves either colour is held to 4.5. Every other shipped
    //     theme clears 4.5.
    //   * status-blocked as text, 4.5:1 on both grounds.
    //   * The Send slot's refusal is a Notice of tone `caution`: `text-status-working` on
    //     `bg-status-working/15`, over the page or a card. That is exactly the `status-working chip`
    //     pair of the loop above, so it needs no pair of its own.
    for (const groundToken of CHIP_GROUNDS) {
      const destructive = contrast(values.destructive ?? "", values[groundToken] ?? "");
      push(`destructive on ${groundToken}`, destructive, NON_TEXT_FLOOR);
      const baseValues = base[half] ?? {};
      const asBase = values.destructive === baseValues.destructive && values[groundToken] === baseValues[groundToken];
      const textFloor = asBase
        ? Math.min(
            TEXT_FLOOR,
            Math.max(NON_TEXT_FLOOR, Math.floor(contrast(baseValues.destructive ?? "", baseValues[groundToken] ?? "") * 100) / 100),
          )
        : TEXT_FLOOR;
      push(`destructive text on ${groundToken}`, destructive, textFloor);
      push(`status-blocked text on ${groundToken}`, contrast(values["status-blocked"] ?? "", values[groundToken] ?? ""), TEXT_FLOOR);
    }
    push("rule on background", contrast(values.rule ?? "", values.background ?? ""), RULE_FLOOR);
    // THE OPTIONAL TOKEN (version 3). Measured only in a half the theme sets, so a file that leaves
    // it out reports exactly what it reported before. The active pane's frame is a shape, held to
    // the non-text floor.
    if (theme[half]?.["pane-active"] !== undefined) {
      push("pane-active on background", contrast(values["pane-active"] ?? "", values.background ?? ""), NON_TEXT_FLOOR);
    }

    // THE GROUND AND THE BAND (M57 spec 17). A gradient or a grain changes the page colour under the
    // text from the top to the bottom, so every pair measured on `background` above is measured again
    // on the other end: the gradient's bottom colour, or the grain's line colour, each the oklab mix
    // index.css draws. Under `chrome: band` the header and the two bars stand on `secondary`, so the
    // text they hold is measured there.
    const surface = resolveSurface(theme.surface);
    const groundMix = surface.ground === "gradient" ? GROUND_GRADIENT_END : surface.ground === "grain" ? GROUND_GRAIN_LINE : undefined;
    if (groundMix !== undefined) {
      const end = mixOklab(values[groundMix.base] ?? "", values[groundMix.mix] ?? "", groundMix.percent);
      const where = `the ${surface.ground} ground`;
      push(`foreground on ${where}`, contrast(values.foreground ?? "", end), TEXT_FLOOR);
      push(`muted-foreground on ${where}`, contrast(values["muted-foreground"] ?? "", end), TEXT_FLOOR);
      const endRgba = toRgba(end);
      for (const status of STATUS_TOKENS) {
        const ink = rgba(status);
        const value =
          ink === undefined || endRgba === undefined ? 1 : ratio(over(ink, endRgba, ink.alpha), over(ink, endRgba, CHIP_ALPHA * ink.alpha));
        push(`${status} chip on ${where}`, value, TEXT_FLOOR);
      }
      const onPage = findings.find((f) => f.half === half && f.check === "destructive text on background");
      push(`destructive text on ${where}`, contrast(values.destructive ?? "", end), onPage?.floor ?? TEXT_FLOOR);
      push(`status-blocked text on ${where}`, contrast(values["status-blocked"] ?? "", end), TEXT_FLOOR);
      push(`rule on ${where}`, contrast(values.rule ?? "", end), RULE_FLOOR);
    }
    if (surface.chrome === "band") {
      for (const ink of ["foreground", "muted-foreground", "status-blocked"] as const) {
        push(`${ink} on the band`, contrast(values[ink] ?? "", values.secondary ?? ""), TEXT_FLOOR);
      }
    }

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

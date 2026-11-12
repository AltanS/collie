// THE THEME CATALOGUE: every key, token, word and limit of a theme file, described once.
//
// `docs/themes-reference.md` is written from this file by `scripts/themes-reference.ts`, and
// `scripts/themes-reference.test.ts` holds both to the parser. The words are this file's. The names,
// the numbers and the defaults are read from the parser's own tables (`schema.ts`, `surface.ts`,
// `mark-ids.ts`, `glyph-sets.ts`, `shipped-fonts.ts`) and from the shipped theme `collie.json`, so a
// number cannot drift. A new token, shape word, character, glyph set or file key is a compile error
// until it is described here.
//
// Pure data and types, with no DOM and no node import, so the web app, the CLI and the scripts load it alike.

import collieFile from "../../themes/collie.json";
import { GLYPH_SETS, type GlyphSetId } from "../glyph-sets";
import { MARKS, type MarkId } from "../mark-ids";
import { SHIPPED_FONTS, type ShippedFont } from "../shipped-fonts";
import {
  ALL_THEME_TOKENS,
  ANSI_BRIGHT_LUMINANCE,
  ANSI_BRIGHT_SLOTS,
  ANSI_SLOT_FLOOR,
  AUTHOR_MAX,
  BLOCKED_DONE_FLOOR,
  CHIP_ALPHA,
  COLOUR_MAX,
  HARD_TEXT_FLOOR,
  NAME_MAX,
  NON_TEXT_FLOOR,
  OPTIONAL_THEME_TOKENS,
  RULE_FLOOR,
  SHIPPED_THEME_IDS,
  TEXT_FLOOR,
  THEME_MAX_BYTES,
  THEME_VERSIONS_READ,
  TOP_KEYS,
  type AnyThemeToken,
  type ThemeVersion,
} from "./schema";
import {
  ANSI_KEYS,
  GROUND_INKS,
  GROUND_KEYS,
  GROUND_PATTERN_WORDS,
  GROUND_SIZES,
  GROUND_SIZE_WORDS,
  GROUND_STRENGTHS,
  GROUND_STRENGTH_WORDS,
  SURFACE,
  SURFACE_DEFAULTS,
  SURFACE_TOKENS,
  groundWords,
  type Declaration,
  type GroundKey,
  type GroundPatternWord,
  type SurfaceToken,
  type SurfaceWord,
} from "./surface";

// ── Types ────────────────────────────────────────────────────────────────────────────────────

/** A number and what it limits, read from the constant that holds it. */
export interface Limit {
  readonly what: string;
  readonly value: string;
}

/** One key of a theme file. */
export interface FileKeyEntry {
  readonly key: (typeof TOP_KEYS)[number];
  readonly type: string;
  readonly needed: string;
  /** The version that first holds it. */
  readonly version: ThemeVersion;
  readonly what: string;
}

/** One version of the file format. */
export interface VersionEntry {
  readonly version: ThemeVersion;
  readonly holds: string;
  /** A complete file at exactly this version, which the parser reads and writes back as this version. */
  readonly example: string;
}

export type TokenGroup = "Surfaces and inks" | "Status" | "Syntax" | "Host" | "Optional";

/** One colour token. */
export interface TokenEntry {
  readonly token: AnyThemeToken;
  readonly group: TokenGroup;
  readonly optional: boolean;
  readonly what: string;
  /** Where the theme Collie sets it: the default of a half that leaves it out. */
  readonly light: string;
  readonly dark: string;
}

/** One word of a shape key. */
export interface WordEntry {
  readonly word: string;
  readonly isDefault: boolean;
  readonly what: string;
  /** The custom properties the word sets, with a short value: `--icon-stroke: 2`. Empty when the app reads the word itself. */
  readonly sets: string;
}

/** One key of the `surface` block, with its words. */
export interface SurfaceKeyEntry {
  readonly key: SurfaceToken;
  readonly version: ThemeVersion;
  readonly what: string;
  readonly words: readonly WordEntry[];
}

/** One key of the object form of `surface.ground`. */
export interface GroundKeyEntry {
  readonly key: GroundKey;
  readonly words: readonly string[];
  readonly what: string;
}

export interface GroundPatternEntry {
  readonly word: GroundPatternWord;
  readonly what: string;
}

export interface AnsiGate {
  readonly gate: string;
  readonly rule: string;
}

export interface NamedEntry {
  readonly word: string;
  readonly name: string;
  readonly what: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const code = (text: string): string => `\`${text}\``;
const codeList = (words: readonly string[]): string => words.map(code).join(", ");

/** The longest value that the page prints; a shadow list or a gradient is not a table cell. */
const SETS_VALUE_MAX = 16;

/** The most properties that a cell lists. */
const SETS_COUNT_MAX = 3;

/**
 * The properties a word sets, as `--name: value`. A word whose properties are many or long (a shadow
 * list, a gradient) leaves the cell empty, except the corner steps of `radius`, which are the point of it.
 * Empty too when the app reads the word itself.
 */
function setsOf(key: SurfaceToken, declarations: readonly Declaration[]): string {
  const shown = key === "radius" ? declarations.filter(([property]) => property.startsWith("--radius-")) : declarations;
  const short = shown.length <= (key === "radius" ? 4 : SETS_COUNT_MAX) && shown.every(([, value]) => value.length <= SETS_VALUE_MAX);
  return short ? shown.map(([property, value]) => code(`${property}: ${value}`)).join(", ") : "";
}

// ── The file ─────────────────────────────────────────────────────────────────────────────────

const FILE_KEY_WORDS = {
  $schema: { type: "text", needed: "no", version: 1, what: "Allowed and ignored, so an editor can offer help." },
  version: { type: "whole number", needed: "yes", version: 1, what: `The version of the format. This Collie reads ${THEME_VERSIONS_READ.join(", ")}. Write the lowest version that holds the file.` },
  id: { type: "text", needed: "yes", version: 1, what: `1 to 32 of \`a-z\`, \`0-9\` and \`-\`, starting with a letter or a digit. The id of a theme that Collie ships (${codeList(SHIPPED_THEME_IDS)}) is refused.` },
  name: { type: "text", needed: "yes", version: 1, what: `1 to ${String(NAME_MAX)} characters, with no control character.` },
  author: { type: "text", needed: "no", version: 1, what: `At most ${String(AUTHOR_MAX)} characters, with no control character.` },
  light: { type: "object of tokens", needed: "one of light and dark", version: 1, what: "The colours of the light half. A token it leaves out takes the value of the theme Collie." },
  dark: { type: "object of tokens", needed: "one of light and dark", version: 1, what: "The colours of the dark half. A token it leaves out takes the value of the theme Collie." },
  fonts: { type: "object", needed: "no", version: 1, what: `\`ui\` (the face of the app, from version 1) and \`display\` (the face of titles, from version 2). Each is one of ${codeList(SHIPPED_FONTS)}.` },
  surface: { type: "object of words", needed: "no", version: 2, what: "The shape words. Every key is optional, and a key left out takes its default word." },
  ansi: { type: "object of colours", needed: "no", version: 2, what: "The terminal palette. It holds all 18 keys or none." },
  character: { type: "word", needed: "no", version: 4, what: "The character in the header, one word of the characters table." },
  glyphs: { type: "word", needed: "no", version: 4, what: "The icon set every icon is drawn in, one word of the glyph sets table." },
} as const satisfies { readonly [K in (typeof TOP_KEYS)[number]]: Omit<FileKeyEntry, "key"> };

/** One entry per key a theme file may have, in the parser's order. */
export const FILE_KEYS: readonly FileKeyEntry[] = TOP_KEYS.map((key) => Object.assign({ key }, FILE_KEY_WORDS[key]));

/** A complete file that uses every part of version 4. The test holds it to the real parser. */
export const FILE_EXAMPLE = JSON.stringify(
  {
    version: 4,
    id: "my-day",
    name: "My day",
    author: "Sam",
    light: { background: "oklch(0.985 0 0)", primary: "oklch(0.18 0 0)" },
    dark: { background: "oklch(0.12 0 0)", "status-blocked": "oklch(0.81 0.13 60)", find: "oklch(0.769 0.188 70.08 / 0.4)" },
    fonts: { ui: "geist", display: "atkinson" },
    surface: { radius: "round", shadow: "lifted", rows: "cards", chrome: "page", ground: { pattern: "dots", size: "fine", strength: "faint" } },
    ansi: {
      "0": "#3a332c",
      "1": "#ff5f56",
      "2": "#5fd068",
      "3": "#ffd84a",
      "4": "#5aa9ff",
      "5": "#e07ce8",
      "6": "#3fd6d0",
      "7": "#f2efe9",
      "8": "#8a827a",
      "9": "#ff8a80",
      "10": "#7ad683",
      "11": "#ffeb8a",
      "12": "#8cc4ff",
      "13": "#f0a6f5",
      "14": "#6ad8d2",
      "15": "#ffffff",
      ink: "#f5f0e8",
      ground: "#1a1612",
    },
    character: "kawaii",
    glyphs: "phosphor",
  },
  null,
  2,
);

const VERSION_WORDS = {
  1: { holds: "Colours in `light` and `dark`, and `fonts.ui`.", example: { version: 1, id: "my-day", name: "My day", fonts: { ui: "geist" }, light: { background: "oklch(0.985 0 0)" } } },
  2: { holds: "Everything in version 1, and any of `surface`, `fonts.display` and `ansi`.", example: { version: 2, id: "my-day", name: "My day", surface: { radius: "round" }, light: { background: "oklch(0.985 0 0)" } } },
  3: { holds: `Everything in version 2, and the optional tokens ${codeList(OPTIONAL_THEME_TOKENS)}.`, example: { version: 3, id: "my-day", name: "My day", dark: { find: "oklch(0.769 0.188 70.08 / 0.4)" } } },
  4: { holds: "Everything in version 3, the keys `character` and `glyphs`, and `surface.ground` as an object.", example: { version: 4, id: "my-day", name: "My day", character: "kawaii", light: { background: "oklch(0.985 0 0)" } } },
} as const satisfies { readonly [V in ThemeVersion]: { readonly holds: string; readonly example: object } };

/** One entry per version the parser reads. */
export const VERSIONS: readonly VersionEntry[] = THEME_VERSIONS_READ.map((version) => ({
  version,
  holds: VERSION_WORDS[version].holds,
  example: JSON.stringify(VERSION_WORDS[version].example, null, 2),
}));

/** The limits of a file, each read from the constant that holds it. */
export const LIMITS: readonly Limit[] = [
  { what: "The file", value: `at most ${String(THEME_MAX_BYTES / 1024)} KiB` },
  { what: "A colour value", value: `at most ${String(COLOUR_MAX)} characters, as \`#rrggbb\`, \`#rrggbbaa\`, \`oklch(L C H)\` or \`oklch(L C H / A)\`. L is 0 to 1, C is 0 to 0.5, H is 0 to 360, A is 0 to 1 or a percentage. No named colour, no \`rgb()\`, no \`var()\`` },
  { what: "A colour in `ansi`", value: "as above, with no alpha" },
  { what: "`foreground` on `background`, in each half", value: `a ratio of at least ${String(HARD_TEXT_FLOOR)}, or the file is refused` },
];

// ── Colour tokens ────────────────────────────────────────────────────────────────────────────

const TOKEN_WORDS = {
  background: { group: "Surfaces and inks", what: "The page." },
  foreground: { group: "Surfaces and inks", what: "Text on the page." },
  card: { group: "Surfaces and inks", what: "A raised panel." },
  "card-foreground": { group: "Surfaces and inks", what: "Text on a card." },
  chrome: { group: "Surfaces and inks", what: "The header and the bars." },
  primary: { group: "Surfaces and inks", what: "The main button." },
  "primary-foreground": { group: "Surfaces and inks", what: "The text on the main button." },
  "control-on": { group: "Surfaces and inks", what: "A switch or a segment that is on." },
  "control-on-foreground": { group: "Surfaces and inks", what: "The text on a switch or a segment that is on." },
  secondary: { group: "Surfaces and inks", what: "A quieter button. Also the fill of the band under `chrome: band`." },
  "secondary-foreground": { group: "Surfaces and inks", what: "The text on a quieter button." },
  muted: { group: "Surfaces and inks", what: "A quiet surface." },
  "muted-foreground": { group: "Surfaces and inks", what: "The grey text." },
  accent: { group: "Surfaces and inks", what: "A hover or a selected row." },
  "accent-foreground": { group: "Surfaces and inks", what: "The text on a hover or a selected row." },
  destructive: { group: "Surfaces and inks", what: "The delete button." },
  "destructive-foreground": { group: "Surfaces and inks", what: "The text on the delete button." },
  border: { group: "Surfaces and inks", what: "The edge of a box." },
  input: { group: "Surfaces and inks", what: "The edge of a field." },
  rule: { group: "Surfaces and inks", what: "A thin line between rows." },
  ring: { group: "Surfaces and inks", what: "The focus ring." },
  "status-blocked": { group: "Status", what: "An agent waits on you." },
  "status-working": { group: "Status", what: "An agent is working." },
  "status-done": { group: "Status", what: "An agent is done." },
  "status-idle": { group: "Status", what: "An agent is at rest." },
  "status-unknown": { group: "Status", what: "Collie cannot tell." },
  "status-info": { group: "Status", what: "A note, not a state." },
  "syntax-keyword": { group: "Syntax", what: "Keywords in code and diffs." },
  "syntax-string": { group: "Syntax", what: "Strings in code and diffs." },
  "syntax-constant": { group: "Syntax", what: "Numbers and constants in code and diffs." },
  "syntax-property": { group: "Syntax", what: "Property names in code and diffs." },
  "syntax-entity": { group: "Syntax", what: "Types and function names in code and diffs." },
  "syntax-comment": { group: "Syntax", what: "Comments in code and diffs." },
  "host-0": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-1": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-2": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-3": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-4": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-5": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-6": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-7": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-8": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "host-9": { group: "Host", what: "One of the ten colours that tell your machines apart." },
  "pane-active": { group: "Optional", what: "The frame of the active pane column on a large screen. A half that leaves it out takes the ink of the theme Collie." },
  "tab-active": { group: "Optional", what: "The top edge of the open tab and the ring of the open pane, when the theme sets `tabs` to `folder`. A half that leaves it out takes its own text colour." },
  find: { group: "Optional", what: "The ground under a found or matched piece of text: a hit of Find in Chat, and the marked letters of the session filter. Give it an alpha, because it lies over the surface under the text and the text keeps its own colour. A half that leaves it out takes the amber of the theme Collie." },
} as const satisfies { readonly [K in AnyThemeToken]: { readonly group: TokenGroup; readonly what: string } };

/** One entry per token a half may name, in the parser's order. */
export const TOKENS: readonly TokenEntry[] = ALL_THEME_TOKENS.map((token) => ({
  token,
  group: TOKEN_WORDS[token].group,
  optional: OPTIONAL_THEME_TOKENS.some((name) => name === token),
  what: TOKEN_WORDS[token].what,
  light: collieFile.light[token],
  dark: collieFile.dark[token],
}));

// ── Shape words ──────────────────────────────────────────────────────────────────────────────

const SURFACE_KEY_WORDS = {
  radius: {
    what: "The corners of controls, at four steps. A circle stays a circle. A marked row wears a bar on its left edge under `sharp`, and a ring on all four sides under `soft` and `round`.",
    words: {
      sharp: "Square corners at every step.",
      soft: "Slightly rounded corners.",
      round: "Round corners.",
    },
  },
  shadow: {
    what: "The shadows under raised things.",
    words: {
      flat: "No shadow anywhere.",
      default: "Soft shadows of the usual sizes.",
      lifted: "Every shadow one step deeper.",
    },
  },
  density: {
    what: "The space around controls. Tap targets never go below their default size, and the icons keep theirs.",
    words: {
      default: "Spacing as it is.",
      roomy: "Every space, gap, height and width a little larger.",
    },
  },
  weight: {
    what: "How heavy medium and semibold text is.",
    words: {
      bold: "Heavier medium and semibold text.",
      default: "Lighter medium and semibold text.",
    },
  },
  border: {
    what: "The width of the lines around things.",
    words: {
      default: "Thin lines.",
      strong: "Thicker lines.",
    },
  },
  ground: {
    what: "What is drawn behind the page. A word here, or the object form of version 4 (see Ground).",
    words: {
      flat: "The page is one colour.",
      gradient: "The page runs from `background` at the top toward `background` mixed with `primary` at the foot.",
      grain: "Fine diagonal lines of `background` mixed with `foreground`. The theme Collie names it.",
    },
  },
  chrome: {
    what: "How the header, the tab bar and the bottom bar are drawn.",
    words: {
      band: "Filled with `secondary` and edged with `border`.",
      page: "The page colour with a rule.",
    },
  },
  rows: {
    what: "How the rows of a list are drawn.",
    words: {
      rules: "One framed group with a line between rows.",
      cards: "Every row is its own card: a gap, an edge, a corner, a small shadow and the `card` colour.",
    },
  },
  icons: {
    what: "The width of the lines of an icon.",
    words: {
      default: "Icon lines of the usual width.",
      thin: "Thinner icon lines.",
      heavy: "Heavier icon lines.",
    },
  },
  labels: {
    what: "How small section labels are written.",
    words: {
      sentence: "As they are typed.",
      caps: "In capitals with a little spacing.",
    },
  },
  zoom: {
    what: "Whether the Zoom pill shows on the Belt.",
    words: {
      screen: "It shows in the Screen view, never in Chat.",
      none: "It never shows.",
    },
  },
  tabs: {
    what: "How the open tab is drawn.",
    words: {
      plain: "The open tab differs from the others by its text colour and weight only.",
      folder: "The open tab is a folder tab, filled with the page colour, with a line on each side and a top edge in `tab-active`. It joins the row of panes under it, and the open pane is a tinted cell with a ring in `tab-active`.",
    },
  },
  composer: {
    what: "How the composer is drawn.",
    words: {
      field: "One text field with its row of controls.",
      box: "A box.",
    },
  },
} as const satisfies { readonly [T in SurfaceToken]: { readonly what: string; readonly words: { readonly [W in SurfaceWord<T>]: string } } };

/** The version that first holds a shape key. `zoom`, `tabs` and `composer` came later than the first five, but a file that names them still says 2 (see `versionOf`). */
const SURFACE_VERSION = 2 as const;

/** One entry per `surface` key, with its words, the default first. */
export const SURFACE_ENTRIES: readonly SurfaceKeyEntry[] = SURFACE_TOKENS.map((key) => {
  const words: readonly string[] = Object.keys(SURFACE[key]);
  const said: Readonly<Record<string, string>> = SURFACE_KEY_WORDS[key].words;
  const declarations: Readonly<Record<string, readonly Declaration[]>> = SURFACE[key];
  return {
    key,
    version: SURFACE_VERSION,
    what: SURFACE_KEY_WORDS[key].what,
    words: words.map((word) => ({
      word,
      isDefault: SURFACE_DEFAULTS[key] === word,
      what: said[word] ?? "",
      sets: setsOf(key, declarations[word] ?? []),
    })),
  };
});

// ── Ground ───────────────────────────────────────────────────────────────────────────────────

const GROUND_KEY_WORDS = {
  pattern: "What is drawn behind the page.",
  size: "The spacing of the pattern: its default, three quarters of it, or twice it.",
  strength: "How much ink is mixed into the page colour.",
  ink: "The colour mixed in. `gradient` takes `primary`, every other pattern `foreground`.",
} as const satisfies { readonly [K in GroundKey]: string };

/** One entry per key of the object form of `surface.ground` (version 4). */
export const GROUND_KEY_ENTRIES: readonly GroundKeyEntry[] = GROUND_KEYS.map((key) => ({ key, words: groundWords(key), what: GROUND_KEY_WORDS[key] }));

const PATTERN_WORDS = {
  flat: "Nothing. The page is one colour.",
  gradient: "The page darkens or lightens toward the foot.",
  grain: "Two sets of fine diagonal lines. The ground of the theme Collie.",
  dots: "A small dot at a regular pitch.",
  grid: "Lines across and down.",
  lines: "One set of diagonal lines.",
  checks: "A checker of squares.",
  waves: "Rows of wavy lines.",
  weave: "A woven pattern, like cloth.",
} as const satisfies { readonly [W in GroundPatternWord]: string };

export const GROUND_PATTERN_ENTRIES: readonly GroundPatternEntry[] = GROUND_PATTERN_WORDS.map((word) => ({ word, what: PATTERN_WORDS[word] }));

/** The size words with the factor each puts on every pitch. */
export const GROUND_SIZE_ENTRIES: readonly { readonly word: string; readonly factor: string }[] = GROUND_SIZE_WORDS.map((word) => ({ word, factor: GROUND_SIZES[word] }));

/** The strength words with the percent of ink each mixes into a line, a dot, a shape and the foot of a gradient. */
export const GROUND_STRENGTH_ENTRIES: readonly { readonly word: string; readonly line: number; readonly dot: number; readonly area: number; readonly tint: number }[] = GROUND_STRENGTH_WORDS.map((word) => Object.assign({ word }, GROUND_STRENGTHS[word]));

export const GROUND_INK_WORDS: readonly string[] = GROUND_INKS;

// ── The terminal palette ─────────────────────────────────────────────────────────────────────

/** The 18 keys of an `ansi` block, in the order they are applied. */
export const ANSI_KEY_WORDS: readonly string[] = ANSI_KEYS;

export const ANSI_GATES: readonly AnsiGate[] = [
  { gate: "Ink", rule: `\`ink\` on \`ground\` at ${String(TEXT_FLOOR)} or better.` },
  { gate: "Dark space", rule: "`ground` is darker than `ink`." },
  { gate: "Slots", rule: `Slots 1 to 15 on \`ground\` at ${String(ANSI_SLOT_FLOOR)} or better. Slot 0 is exempt, because black draws as no colour.` },
  { gate: "Bright set", rule: `Slots ${ANSI_BRIGHT_SLOTS.join(", ")} have a relative luminance above ${String(ANSI_BRIGHT_LUMINANCE)}.` },
  { gate: "The rest", rule: `The other ${String(ANSI_KEYS.length - 2 - ANSI_BRIGHT_SLOTS.length)} slots have a relative luminance of ${String(ANSI_BRIGHT_LUMINANCE)} or less.` },
];

// ── The contrast report ──────────────────────────────────────────────────────────────────────

/** The floors of the contrast report. A report warns and never refuses. */
export const REPORT_FLOORS: readonly Limit[] = [
  { what: "Text on a ground (`foreground`, `muted-foreground`, the status chips, `status-blocked` and `destructive` as text)", value: String(TEXT_FLOOR) },
  { what: "`destructive` as an icon", value: String(NON_TEXT_FLOOR) },
  { what: "`rule` on `background`", value: String(RULE_FLOOR) },
  { what: "A status colour over its wash, as a chip", value: `${String(TEXT_FLOOR)}, with the colour over a wash of ${String(CHIP_ALPHA * 100)} percent` },
  { what: "`status-blocked` apart from `status-done`", value: `a distance of ${String(BLOCKED_DONE_FLOOR)}` },
];

// ── Faces, characters, glyph sets ────────────────────────────────────────────────────────────

const FONT_NAMES = {
  system: "the system font",
  grotesk: "Space Grotesk",
  aldrich: "Aldrich",
  plex: "IBM Plex Sans",
  geist: "Geist",
  atkinson: "Atkinson Hyperlegible Next",
  nunito: "Nunito",
} as const satisfies { readonly [F in ShippedFont]: string };

export const FONTS: readonly { readonly word: ShippedFont; readonly name: string }[] = SHIPPED_FONTS.map((word) => ({ word, name: FONT_NAMES[word] }));

const CHARACTER_WORDS = {
  collie: "The collie head in profile, in the ink of the page. The default.",
  kawaii: "A round puppy face from the front, with big glossy eyes and candy pearls.",
  "kawaii-tilt": "The same puppy with its head tilted.",
  pixel: "An 8-bit collie head with square beads that hop.",
  glass: "A collie head in profile as a leaded stained-glass panel, with jewels in the ring.",
  "glass-front": "The same stained glass, the head from the front.",
  sheep: "The sheep the collie herds: a charcoal face in cream wool, in profile.",
  owl: "The owl that watches through the night, from the front, with huge amber eyes.",
} as const satisfies { readonly [M in MarkId]: string };

export const CHARACTERS: readonly NamedEntry[] = MARKS.map((mark) => ({ word: mark.id, name: mark.name, what: CHARACTER_WORDS[mark.id] }));

const GLYPH_WORDS = {
  lucide: "Round lines of even width. The default.",
  phosphor: "Soft and slightly rounder lines.",
  "phosphor-fill": "The Phosphor icons as solid shapes.",
  "phosphor-duotone": "The Phosphor lines with a pale fill behind them.",
  iconoir: "Light, open lines.",
} as const satisfies { readonly [G in GlyphSetId]: string };

export const GLYPH_SET_ENTRIES: readonly NamedEntry[] = GLYPH_SETS.map((set) => ({ word: set.id, name: set.name, what: GLYPH_WORDS[set.id] }));

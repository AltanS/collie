// The shape of a theme, schema version 2 (M57 specs 14 and 17): thirteen tokens, each a CLOSED list of
// words, and the one table that turns a word into CSS declarations. Beside it, two more closed doors
// of version 2 that are not words of the `surface` block: the display face (`fonts.display`, one of
// the shipped faces) and the terminal palette (`ansi`, eighteen gate-checked colours).
//
// WHY WORDS AND NOT VALUES. A theme may make the corners rounder or the rows roomier, but it may not
// pick a number. A free radius or a free spacing step is how a file breaks the 44px tap floor, makes
// a stadium out of a square control, or shrinks a row until its text clips. So a file names a word,
// and this table says what the word does. Nothing in a file ever reaches a declaration value.
//
// ONE TABLE, FOUR READERS. `schema.ts` checks a file's words against it, `themes-css.ts` writes a
// shipped theme's words into themes.css, `store.ts` sets an imported theme's words as inline
// properties, and `public/theme-init.js` does the same before first paint. theme-init.js cannot import
// anything, so `scripts/build-themes.ts` writes `SURFACE_INIT_LINE` into it from this table, and
// `src/theme-init.test.ts` fails when the line in the file is not the line this module writes.
//
// HOW EACH TOKEN REACHES THE PAGE. Tailwind compiles some theme values into each utility and reads
// others through var(); the first ten tokens are the ones that end in a property a utility reads at run time; the last three, zoom, tabs and composer, end in none.
//   * radius: `--radius-sm/md/lg/xl`. index.css declares them in `@theme` (not `@theme inline`), so
//     `rounded-md` compiles to `border-radius: var(--radius-md)`. Bare `rounded` and `rounded-full`
//     are not steps and never move. The radius word also sets `--edge-accent`, the offsets of the
//     inset shadow that marks a selected or blocked row (`shadow-[var(--edge-accent)_<colour>]`).
//     Sharp keeps the 2px bar on the left edge; soft and round draw a 2px ring on all four sides,
//     because a left accent bar belongs only with square corners. With the ring goes a soft
//     shadow, `--edge-shadow`, the second layer of a marked row's shadow; sharp sets none.
//   * shadow: Tailwind copies a shadow's value into the utility, so index.css points each step the app
//     uses at a property of its own (`--shadow-md: var(--surface-shadow-md)`), and the word sets those.
//   * density: `--spacing`, the step every `p-*`, `gap-*`, `h-*` and `size-*` multiplies. Icons and
//     the header mark box are pinned to the default step in index.css, so they do not grow.
//   * weight: `--font-weight-medium` and `--font-weight-semibold`, the two weights the app draws.
//   * border: Tailwind's `--default-border-width`, the width of a bare `border`, `border-t` and
//     `divide-*`. index.css points it at `--surface-border-width`, the same way as the shadows.
//   * ground (spec 17): `--ground-image`, painted on `html` under the page colour. Gradient and grain
//     are built from the theme's own `--background`, `--primary` and `--foreground`, no image file.
//     The gradient runs from `--background` at the top (the browser-chrome edge stays the flat page
//     colour) to {@link GROUND_GRADIENT_END} at the bottom; grain draws two sets of 1px diagonal lines
//     in {@link GROUND_GRAIN_LINE}. schema.ts measures the page's text pairs on both of those colours.
//   * chrome (spec 17): `--band-ground` and `--band-rule`, the fill and the edge of the header, the tab
//     bar and the bottom bar. `page` is the page colour and `--rule`; `band` is `--secondary` with a
//     `--border` edge.
//   * rows (spec 17): the rows of a list group (`[data-slot="list-group"]`, ui/list-group.tsx and the
//     hand-rolled lists that carry the slot). `rules` is today's framed group with a line between
//     rows; `cards` drops the frame and the lines and gives every row its own border, corner,
//     extra-small shadow and card fill (`--row-fill`, spec 18), with a gap between rows. index.css
//     holds the one rule that reads these. Under `rules` the fill is `transparent`, a row's own
//     background as before, and a row's own `bg-*` utility wins in both.
//   * icons (spec 17): `--icon-stroke`, the stroke width of every lucide icon (`svg.lucide`).
//   * labels (spec 17): `--label-transform` and `--label-tracking`, read by the `label-caps` utility
//     every small section label wears.
//   * zoom (1.26.2): the one word that sets no property. It says whether the belt's Zoom pill shows
//     in the Screen view (`screen`, today's behaviour) or never (`none`). Its words hold no
//     declarations, so nothing reaches the page; the app reads the word itself (lib/zoom-pill.ts),
//     and a device choice in Settings wins over it.
//   * tabs: the second word that sets no property. It says how the open tab is drawn.
//     `plain` is today's row, ink and weight and nothing else; `folder` draws the open tab as a
//     folder tab that joins the page below it (components/tab-strip.tsx, pane-strip.tsx). The app
//     reads the word itself (lib/tab-look.ts). Its colour is the optional token `tab-active`.
//   * composer: the third. It says how the composer is laid out: `field` is today's
//     (one text field with its row of controls), `box` a boxed composer (lib/composer-layout.ts).
//
// EVERY DEFAULT IS THE STYLESHEET'S VALUE. `src/themes/themes.test.ts` reads index.css and holds each
// default word equal to what `:root` declares. Since the theme Collie New became `collie`, that is the
// flat, bold, banded look; the word named `default` of `shadow` and `weight` is Tailwind's own stock
// value, kept as a word so a stored theme that names it still validates.
//
// It imports one leaf file, for the same reason `schema.ts` imports little: the build script loads it
// with plain Bun.

import { SHIPPED_FONTS, isShippedFont, type ShippedFont } from "../shipped-fonts";

/** The thirteen shape tokens, in the order a file's words are applied. */
export const SURFACE_TOKENS = [
  "radius",
  "shadow",
  "density",
  "weight",
  "border",
  "ground",
  "chrome",
  "rows",
  "icons",
  "labels",
  "zoom",
  "tabs",
  "composer",
] as const;

export type SurfaceToken = (typeof SURFACE_TOKENS)[number];

/** One CSS declaration: a custom property and its value. */
export type Declaration = readonly [property: string, value: string];

const NONE = "0 0 #0000";

/** Tailwind 4.3.1's shadow steps, the values `theme.css` ships and the app drew before version 2. */
const SHADOW = {
  xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
} as const;

/** One step past `2xl`, softer and larger, for `lifted`. */
const SHADOW_3XL = "0 32px 64px -12px rgb(0 0 0 / 0.3)";

/** The seven shadow utilities the app uses: bare `shadow` and six steps. */
function shadows(bare: string, xs: string, sm: string, md: string, lg: string, xl: string, xxl: string): Declaration[] {
  return [
    ["--surface-shadow", bare],
    ["--surface-shadow-xs", xs],
    ["--surface-shadow-sm", sm],
    ["--surface-shadow-md", md],
    ["--surface-shadow-lg", lg],
    ["--surface-shadow-xl", xl],
    ["--surface-shadow-2xl", xxl],
  ];
}

/** The left bar a marked row wears under square corners: today's literal. */
const EDGE_BAR = "inset 2px 0 0 0";
/** The ring on all four sides a marked row wears under rounded corners, the same 2px. */
const EDGE_RING = "inset 0 0 0 2px";
/** The soft shadow that goes with the ring, Tailwind's `shadow-sm` first layer. */
const EDGE_SOFT = "0 1px 3px 0 rgb(0 0 0 / 0.1)";

function radii(sm: number, md: number, lg: number, xl: number, edge: string, edgeShadow: string): Declaration[] {
  return [
    ["--radius-sm", `${sm}px`],
    ["--radius-md", `${md}px`],
    ["--radius-lg", `${lg}px`],
    ["--radius-xl", `${xl}px`],
    ["--edge-accent", edge],
    ["--edge-shadow", edgeShadow],
  ];
}

// ── The ground (spec 17, and the pattern object of schema version 4) ─────────────────────────────
//
// A ground is four closed words: a PATTERN, its SIZE, its STRENGTH and its INK. A file names it as one
// word (`"grain"`, versions 2 to 4) or as an object of the four (`{ "pattern": "dots", "ink":
// "primary" }`, version 4 only). The word is the object with only a pattern: `"grain"` is
// `{ "pattern": "grain" }`, and both set the same declarations.
//
// FOUR WORDS, FOUR SETS OF PROPERTIES. Each word sets its own custom properties, and the pattern's CSS
// reads them, so the four combine without a table of every combination (theme-init.js holds the four
// small tables, not 162 strings):
//   * pattern  `--ground-image` and `--ground-size` (the html rule paints both), and `--ground-ink`,
//              the pattern's own ink, which an `ink` word then overrides;
//   * size     `--ground-scale`, the factor every pitch in a pattern is multiplied by;
//   * strength `--ground-line`, `--ground-dot`, `--ground-area` and `--ground-tint`: the paint of a
//              thin line, a dot, a filled shape and the gradient's end, each the page colour with a
//              few percent of the ink. A pattern reads the one paint that fits how much it covers.
//   * ink      `--ground-ink`: `var(--foreground)` or `var(--primary)`.
//
// OUR CSS ONLY. Every value is a CSS gradient written here from the theme's own colours. A file never
// supplies a value, a URL, an image or an SVG. The patterns are static: no animation, no blend mode,
// no filter, so the ground costs nothing at rest (issue 748).
//
// CONTRAST. schema.ts measures the page's text on the paint a ground draws, for the words the file
// names ({@link groundPaint}), as it did for the grain and the gradient.

/** How much of the page a pattern covers, which picks the paint it reads. */
type GroundCoverage = "line" | "dot" | "area" | "tint";

/** The ink a ground mixes into the page colour. */
export const GROUND_INKS = ["foreground", "primary"] as const;
export type GroundInk = (typeof GROUND_INKS)[number];

/** A pitch in px, multiplied by the size word's factor. */
function pitch(px: number): string {
  return `calc(${px}px * var(--ground-scale))`;
}

/** A tile of `px` square, at the size word's factor. */
function tile(w: number, h: number = w): string {
  return `${pitch(w)} ${pitch(h)}`;
}

const LINE = "var(--ground-line)";

/** A ring of radius `r` (px, at the size factor) one pixel wide, around a point of the tile. */
function arc(at: string, r: number): string {
  return `radial-gradient(circle at ${at}, transparent calc(${pitch(r)} - 1px), ${LINE} calc(${pitch(r)} - 1px) ${pitch(r)}, transparent ${pitch(r)})`;
}

/** Two sets of 1px diagonal lines, 4px apart at the default size: Collie's own ground since spec 17. */
const GRAIN = `repeating-linear-gradient(45deg, ${LINE} 0 1px, transparent 1px ${pitch(4)}), repeating-linear-gradient(-45deg, ${LINE} 0 1px, transparent 1px ${pitch(4)})`;

/** The weave: three layers of the same tile that read as cloth (Lea Verou's CSS3 pattern gallery). */
const WEAVE = [
  "linear-gradient(45deg, var(--ground-area) 12%, transparent 0 88%, var(--ground-area) 0)",
  "linear-gradient(135deg, transparent 37%, var(--ground-area) 0 63%, transparent 0)",
  "linear-gradient(45deg, transparent 37%, var(--ground-area) 0 63%, transparent 0)",
].join(", ");

/** The patterns, `flat` first. The first three are the word form of versions 2 to 4. */
export const GROUND_PATTERN_WORDS = ["flat", "gradient", "grain", "dots", "grid", "lines", "checks", "waves", "weave"] as const;
export type GroundPatternWord = (typeof GROUND_PATTERN_WORDS)[number];

/** The word form of a ground, versions 2 to 4: the first three patterns, unchanged since spec 17. */
export type GroundWord = "flat" | "gradient" | "grain";

/** True for the word form of a ground, false for the object form. Compares, never indexes. */
export function isGroundWord(ground: GroundWord | GroundSpec): ground is GroundWord {
  return ground === "flat" || ground === "gradient" || ground === "grain";
}

/** The size words, the default first. */
export const GROUND_SIZE_WORDS = ["default", "fine", "wide"] as const;
export type GroundSize = (typeof GROUND_SIZE_WORDS)[number];

/** The strength words, the default first. */
export const GROUND_STRENGTH_WORDS = ["default", "faint", "bold"] as const;
export type GroundStrength = (typeof GROUND_STRENGTH_WORDS)[number];

interface GroundPattern {
  image: string;
  size: string;
  coverage: GroundCoverage | null;
  ink: GroundInk;
}

/**
 * The patterns, `flat` first. The first three are the words of versions 2 and 3; the rest are named
 * only in the object form. Each reads one paint ({@link GroundCoverage}), and `gradient` alone takes
 * the primary as its own ink, as it did before the object form.
 */
export const GROUND_PATTERNS = {
  flat: { image: "none", size: "auto", coverage: null, ink: "foreground" },
  gradient: { image: "linear-gradient(to bottom, var(--background), var(--ground-tint))", size: "auto", coverage: "tint", ink: "primary" },
  grain: { image: GRAIN, size: "auto", coverage: "line", ink: "foreground" },
  dots: { image: "radial-gradient(circle, var(--ground-dot) 0 1.25px, transparent 1.75px)", size: tile(12), coverage: "dot", ink: "foreground" },
  grid: {
    image: `linear-gradient(${LINE} 0 1px, transparent 1px), linear-gradient(90deg, ${LINE} 0 1px, transparent 1px)`,
    size: tile(16),
    coverage: "line",
    ink: "foreground",
  },
  lines: { image: `repeating-linear-gradient(45deg, ${LINE} 0 1px, transparent 1px ${pitch(6)})`, size: "auto", coverage: "line", ink: "foreground" },
  checks: {
    image: "conic-gradient(var(--ground-area) 25%, transparent 0 50%, var(--ground-area) 0 75%, transparent 0)",
    size: tile(16),
    coverage: "area",
    ink: "foreground",
  },
  waves: { image: `${arc("25% 0", 6)}, ${arc("75% 100%", 6)}`, size: tile(24, 12), coverage: "line", ink: "foreground" },
  weave: { image: WEAVE, size: tile(20), coverage: "area", ink: "foreground" },
} as const satisfies Record<GroundPatternWord, GroundPattern>;

/** The size words, the default first: the factor on every pitch. */
export const GROUND_SIZES = { default: "1", fine: "0.75", wide: "2" } as const satisfies Record<GroundSize, string>;

/**
 * The strength words, the default first: the percent of the ink in each paint. `default` is the grain's
 * 4 percent of spec 18 and the gradient's 12; no line, dot or shape ever goes past 10. The gradient's
 * end is one colour spread over the whole page height, so its scale is its own.
 */
export const GROUND_STRENGTHS = {
  default: { line: 4, dot: 7, area: 3, tint: 12 },
  faint: { line: 2.5, dot: 5, area: 2, tint: 7 },
  bold: { line: 7, dot: 10, area: 5, tint: 18 },
} as const satisfies Record<GroundStrength, Record<GroundCoverage, number>>;

/**
 * A ground in the object form, AS WRITTEN. Every key is optional; a key it leaves out is the default
 * word. A word may be one this Collie does not know (a newer Collie's pattern): the theme keeps it, so
 * an export writes it back and a later Collie that knows it draws it, and every reader below resolves
 * it to the default through `knownGround` first. A word only ever reaches the page as a key of
 * GROUND_WORDS, never as itself.
 */
export interface GroundSpec {
  pattern?: string;
  size?: string;
  strength?: string;
  ink?: string;
}

/** A ground in the object form with only the words this Collie knows. */
export interface KnownGround {
  pattern?: GroundPatternWord;
  size?: GroundSize;
  strength?: GroundStrength;
  ink?: GroundInk;
}

/** The words of `spec` this Collie knows; an unknown word is left out, which is its default. Compares, never indexes. */
export function knownGround(spec: GroundSpec): KnownGround {
  const known: KnownGround = {};
  const pattern = GROUND_PATTERN_WORDS.find((word) => word === spec.pattern);
  const size = GROUND_SIZE_WORDS.find((word) => word === spec.size);
  const strength = GROUND_STRENGTH_WORDS.find((word) => word === spec.strength);
  const ink = GROUND_INKS.find((word) => word === spec.ink);
  if (pattern !== undefined) known.pattern = pattern;
  if (size !== undefined) known.size = size;
  if (strength !== undefined) known.strength = strength;
  if (ink !== undefined) known.ink = ink;
  return known;
}

/** The known words of a ground, word or object. */
function knownOf(ground: GroundWord | GroundSpec | undefined): KnownGround {
  if (ground === undefined) return {};
  return isGroundWord(ground) ? { pattern: ground } : knownGround(ground);
}

/** The four keys of the object form, in the order they are applied. */
export const GROUND_KEYS = ["pattern", "size", "strength", "ink"] as const;
export type GroundKey = (typeof GROUND_KEYS)[number];

/** `color-mix(in oklab, ...)` of the page colour and `percent` of the ground's ink. */
function paint(percent: number): string {
  return `color-mix(in oklab, var(--background) ${100 - percent}%, var(--ground-ink))`;
}

/** The declarations of each word of each key. Every word of a key sets the same properties. */
const GROUND_WORDS = {
  pattern: Object.fromEntries(
    GROUND_PATTERN_WORDS.map((word): [string, Declaration[]] => [
      word,
      [
        ["--ground-image", GROUND_PATTERNS[word].image],
        ["--ground-size", GROUND_PATTERNS[word].size],
        ["--ground-ink", `var(--${GROUND_PATTERNS[word].ink})`],
      ],
    ]),
  ),
  size: Object.fromEntries(GROUND_SIZE_WORDS.map((word): [string, Declaration[]] => [word, [["--ground-scale", GROUND_SIZES[word]]]])),
  strength: Object.fromEntries(
    GROUND_STRENGTH_WORDS.map((word): [string, Declaration[]] => [
      word,
      [
        ["--ground-line", paint(GROUND_STRENGTHS[word].line)],
        ["--ground-dot", paint(GROUND_STRENGTHS[word].dot)],
        ["--ground-area", paint(GROUND_STRENGTHS[word].area)],
        ["--ground-tint", paint(GROUND_STRENGTHS[word].tint)],
      ],
    ]),
  ),
  ink: Object.fromEntries(GROUND_INKS.map((ink): [string, Declaration[]] => [ink, [["--ground-ink", `var(--${ink})`]]])),
} satisfies Record<GroundKey, Record<string, Declaration[]>>;

/** The words of one key of the object form, the default first. */
export function groundWords(key: GroundKey): string[] {
  return Object.keys(GROUND_WORDS[key]);
}

/** A ground as its four words. A word form is its pattern; a key left out is the default word, and the ink is the pattern's own. */
export function resolveGround(ground: GroundWord | GroundSpec | undefined): Required<KnownGround> {
  const spec = knownOf(ground);
  const pattern = spec.pattern ?? "flat";
  return { pattern, size: spec.size ?? "default", strength: spec.strength ?? "default", ink: spec.ink ?? GROUND_PATTERNS[pattern].ink };
}

/**
 * The declarations of a ground, word or object: the pattern's, the size's, the strength's, then an
 * ink the object names. Always the same eight properties, so one ground overwrites the last.
 */
export function groundDeclarations(ground: GroundWord | GroundSpec | undefined): Declaration[] {
  const spec = knownOf(ground);
  const out: Declaration[] = [];
  out.push(...(GROUND_WORDS.pattern[spec.pattern ?? "flat"] ?? []));
  out.push(...(GROUND_WORDS.size[spec.size ?? "default"] ?? []));
  out.push(...(GROUND_WORDS.strength[spec.strength ?? "default"] ?? []));
  if (spec.ink !== undefined) out.push(...(GROUND_WORDS.ink[spec.ink] ?? []));
  return out;
}

/** The paint a ground draws, as a mix of the page colour, for the contrast report. Undefined for `flat`. */
export function groundPaint(ground: GroundWord | GroundSpec | undefined): { base: "background"; mix: GroundInk; percent: number } | undefined {
  const g = resolveGround(ground);
  const coverage = GROUND_PATTERNS[g.pattern].coverage;
  if (coverage === null) return undefined;
  return { base: "background", mix: g.ink, percent: GROUND_STRENGTHS[g.strength][coverage] };
}

/** The ground in words for a reader: the word itself, or the object's words in key order. */
export function groundText(ground: GroundWord | GroundSpec): string {
  if (isGroundWord(ground)) return ground;
  const g = resolveGround(ground);
  return GROUND_KEYS.map((key) => g[key]).join(" ");
}

/** The bottom colour of the `gradient` ground: the page with 12 percent of the theme's primary. */
export const GROUND_GRADIENT_END = { base: "background", mix: "primary", percent: GROUND_STRENGTHS.default.tint } as const;
/** The line colour of the `grain` ground: the page with 4 percent of the theme's foreground (6 until
 *  spec 18: at 6 a rule on the light grain measured 1.32 and a dashed ring was lost in it). */
export const GROUND_GRAIN_LINE = { base: "background", mix: "foreground", percent: GROUND_STRENGTHS.default.line } as const;

/**
 * The table. Per token, its words in the order Settings lists them, the default first, and the
 * declarations each word sets. Every word of a token sets the SAME properties, so switching from one
 * theme to another always overwrites what the last one set.
 */
export const SURFACE = {
  radius: {
    sharp: radii(2, 2, 2, 2, EDGE_BAR, NONE),
    soft: radii(4, 6, 8, 12, EDGE_RING, EDGE_SOFT),
    round: radii(8, 12, 16, 24, EDGE_RING, EDGE_SOFT),
  },
  shadow: {
    flat: shadows(NONE, NONE, NONE, NONE, NONE, NONE, NONE),
    default: shadows(SHADOW.sm, SHADOW.xs, SHADOW.sm, SHADOW.md, SHADOW.lg, SHADOW.xl, SHADOW["2xl"]),
    lifted: shadows(SHADOW.md, SHADOW.sm, SHADOW.md, SHADOW.lg, SHADOW.xl, SHADOW["2xl"], SHADOW_3XL),
  },
  density: {
    default: [["--spacing", "0.25rem"]],
    roomy: [["--spacing", "0.28rem"]],
  },
  weight: {
    bold: [
      ["--font-weight-medium", "600"],
      ["--font-weight-semibold", "700"],
    ],
    default: [
      ["--font-weight-medium", "500"],
      ["--font-weight-semibold", "600"],
    ],
  },
  border: {
    default: [["--surface-border-width", "1px"]],
    strong: [["--surface-border-width", "2px"]],
  },
  ground: {
    flat: groundDeclarations("flat"),
    gradient: groundDeclarations("gradient"),
    grain: groundDeclarations("grain"),
  },
  chrome: {
    band: [
      ["--band-ground", "var(--secondary)"],
      ["--band-rule", "var(--border)"],
    ],
    page: [
      ["--band-ground", "var(--background)"],
      ["--band-rule", "var(--rule)"],
    ],
  },
  rows: {
    rules: [
      ["--row-gap", "0px"],
      ["--row-rule", "var(--surface-border-width)"],
      ["--row-edge", "0px"],
      ["--row-corner", "0px"],
      ["--row-shadow", "none"],
      ["--row-inset", "0px"],
      ["--row-fill", "transparent"],
    ],
    cards: [
      ["--row-gap", "8px"],
      ["--row-rule", "0px"],
      ["--row-edge", "var(--surface-border-width)"],
      ["--row-corner", "var(--radius-sm)"],
      ["--row-shadow", "var(--surface-shadow-xs)"],
      ["--row-inset", "8px"],
      ["--row-fill", "var(--card)"],
    ],
  },
  icons: {
    default: [["--icon-stroke", "2"]],
    thin: [["--icon-stroke", "1.5"]],
    heavy: [["--icon-stroke", "2.5"]],
  },
  labels: {
    sentence: [
      ["--label-transform", "none"],
      ["--label-tracking", "normal"],
    ],
    caps: [
      ["--label-transform", "uppercase"],
      ["--label-tracking", "0.025em"],
    ],
  },
  zoom: {
    screen: [],
    none: [],
  },
  tabs: {
    plain: [],
    folder: [],
  },
  composer: {
    field: [],
    box: [],
  },
} as const satisfies { [T in SurfaceToken]: Record<string, readonly Declaration[]> };

export type SurfaceWord<T extends SurfaceToken> = keyof (typeof SURFACE)[T] & string;

/** A theme's shape: one word per token it sets. A token it leaves out is the default word. */
export interface Surface {
  radius?: SurfaceWord<"radius">;
  shadow?: SurfaceWord<"shadow">;
  density?: SurfaceWord<"density">;
  weight?: SurfaceWord<"weight">;
  border?: SurfaceWord<"border">;
  /** A word (versions 2 to 4) or the object of four words (version 4). */
  ground?: SurfaceWord<"ground"> | GroundSpec;
  chrome?: SurfaceWord<"chrome">;
  rows?: SurfaceWord<"rows">;
  icons?: SurfaceWord<"icons">;
  labels?: SurfaceWord<"labels">;
  zoom?: SurfaceWord<"zoom">;
  tabs?: SurfaceWord<"tabs">;
  composer?: SurfaceWord<"composer">;
}

/**
 * The word each token has when a file does not name one: the look of the stylesheet, which is the
 * look of the theme `collie` (flat shadows, bold weight, a band for the chrome, sentence labels).
 * The three words the app reads itself keep their plain words: a theme that names no `tabs` or
 * `composer` word gets the plain tab and the field composer, and the theme `collie` names `folder`
 * and `box` in its file. The `ground` is the same kind of exception: a theme that names none gets
 * `flat`, and only `collie` names `grain`. index.css carries that grain on `:root` for the default
 * theme, so every other theme that draws without a `data-theme` block (an imported one) must set
 * `flat` itself: {@link omittedGroundDeclarations}.
 */
export const SURFACE_DEFAULTS = {
  radius: "sharp",
  shadow: "flat",
  density: "default",
  weight: "bold",
  border: "default",
  ground: "flat",
  chrome: "band",
  rows: "rules",
  icons: "default",
  labels: "sentence",
  zoom: "screen",
  tabs: "plain",
  composer: "field",
} as const satisfies Required<Surface>;

export function isSurfaceToken(value: string): value is SurfaceToken {
  return SURFACE_TOKENS.some((token) => token === value);
}

/** The words of one token, the default first. */
export function surfaceWords<T extends SurfaceToken>(token: T): Array<SurfaceWord<T>> {
  // SAFETY: the keys of `SURFACE[token]` are by definition the words of `token`.
  return Object.keys(SURFACE[token]) as Array<SurfaceWord<T>>;
}

/** The word of `token` that equals `value`, or `undefined`. Compares strings, never indexes by them. */
export function surfaceWordOf<T extends SurfaceToken>(token: T, value: string | undefined): SurfaceWord<T> | undefined {
  return surfaceWords(token).find((word) => word === value);
}

/** Every token's word, a token the surface leaves out filled with its default. */
export function resolveSurface(surface: Surface | undefined): Required<Surface> {
  return {
    radius: surface?.radius ?? SURFACE_DEFAULTS.radius,
    shadow: surface?.shadow ?? SURFACE_DEFAULTS.shadow,
    density: surface?.density ?? SURFACE_DEFAULTS.density,
    weight: surface?.weight ?? SURFACE_DEFAULTS.weight,
    border: surface?.border ?? SURFACE_DEFAULTS.border,
    ground: surface?.ground ?? SURFACE_DEFAULTS.ground,
    chrome: surface?.chrome ?? SURFACE_DEFAULTS.chrome,
    rows: surface?.rows ?? SURFACE_DEFAULTS.rows,
    icons: surface?.icons ?? SURFACE_DEFAULTS.icons,
    labels: surface?.labels ?? SURFACE_DEFAULTS.labels,
    zoom: surface?.zoom ?? SURFACE_DEFAULTS.zoom,
    tabs: surface?.tabs ?? SURFACE_DEFAULTS.tabs,
    composer: surface?.composer ?? SURFACE_DEFAULTS.composer,
  };
}

/** The declarations of one word. */
export function wordDeclarations<T extends SurfaceToken>(token: T, word: SurfaceWord<T>): readonly Declaration[] {
  const words: Record<string, readonly Declaration[]> = SURFACE[token];
  return words[word] ?? [];
}

/** The declarations of the words a surface names, in token order. A token it leaves out sets nothing. */
export function surfaceDeclarations(surface: Surface | undefined): Declaration[] {
  if (surface === undefined) return [];
  const out: Declaration[] = [];
  if (surface.radius !== undefined) out.push(...wordDeclarations("radius", surface.radius));
  if (surface.shadow !== undefined) out.push(...wordDeclarations("shadow", surface.shadow));
  if (surface.density !== undefined) out.push(...wordDeclarations("density", surface.density));
  if (surface.weight !== undefined) out.push(...wordDeclarations("weight", surface.weight));
  if (surface.border !== undefined) out.push(...wordDeclarations("border", surface.border));
  if (surface.ground !== undefined) out.push(...groundDeclarations(surface.ground));
  if (surface.chrome !== undefined) out.push(...wordDeclarations("chrome", surface.chrome));
  if (surface.rows !== undefined) out.push(...wordDeclarations("rows", surface.rows));
  if (surface.icons !== undefined) out.push(...wordDeclarations("icons", surface.icons));
  if (surface.labels !== undefined) out.push(...wordDeclarations("labels", surface.labels));
  if (surface.zoom !== undefined) out.push(...wordDeclarations("zoom", surface.zoom));
  if (surface.tabs !== undefined) out.push(...wordDeclarations("tabs", surface.tabs));
  if (surface.composer !== undefined) out.push(...wordDeclarations("composer", surface.composer));
  return out;
}

/** The declarations of every token, a token the surface leaves out at its default word. */
export function fullSurfaceDeclarations(surface: Surface | undefined): Declaration[] {
  return surfaceDeclarations(resolveSurface(surface));
}

/** Every property any word sets, each once. The store removes these when it takes a theme off. */
export const SURFACE_PROPERTIES: readonly string[] = [
  ...new Set(
    SURFACE_TOKENS.flatMap((token) => surfaceWords(token).flatMap((word) => wordDeclarations(token, word).map(([p]) => p))),
  ),
];

// ── The display face (spec 17) ─────────────────────────────────────────────────────────────────
//
// `fonts.display` names one of the shipped faces for the page titles (`h1`, `h2`) and the header's
// brand line. index.css declares one stack per face as `--face-<id>` and `--font-display:
// var(--font-sans)` on :root, so a theme that names no display face draws its titles in the UI face,
// exactly as before. A face is a stack index.css already holds and a file the app already bundles: no
// new font file, and the browser fetches a face only when a drawn element asks for it.

/** The declarations of one display face: `--font-display` pointed at its stack in index.css. */
export function displayDeclarations(face: ShippedFont): readonly Declaration[] {
  return [["--font-display", `var(--face-${face})`]];
}

/** Every property a display face sets. */
export const DISPLAY_PROPERTIES: readonly string[] = ["--font-display"];

// ── The terminal palette (spec 17) ─────────────────────────────────────────────────────────────
//
// `ansi` holds all eighteen colours or none: the sixteen indexed slots and the mirror's own ink and
// ground. They are dark-space colours, like index.css's own palette, because the mirror renders in
// dark space under every theme and light inverts it (.adr/0002). schema.ts gates them.

/** The eighteen keys of an `ansi` block, in the order they are applied. */
export const ANSI_KEYS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "ink",
  "ground",
] as const;

export type AnsiKey = (typeof ANSI_KEYS)[number];

/** A terminal palette: a colour for each of the eighteen keys. */
export type Ansi = Record<AnsiKey, string>;

/** The custom property an `ansi` key sets: `--ansi-<n>` for a slot, `--mirror-ink`, `--mirror-ground`. */
export function ansiProperty(key: AnsiKey): string {
  if (key === "ink") return "--mirror-ink";
  if (key === "ground") return "--mirror-ground";
  return `--ansi-${key}`;
}

/** The declarations of a palette, in key order. The values are the parser's checked colours. */
export function ansiDeclarations(ansi: Ansi | undefined): Declaration[] {
  if (ansi === undefined) return [];
  return ANSI_KEYS.map((key): Declaration => [ansiProperty(key), ansi[key]]);
}

/** Every property a palette sets. */
export const ANSI_PROPERTIES: readonly string[] = ANSI_KEYS.map(ansiProperty);

/** What of a theme reaches the page beside its colours. A structural type, so this file needs no schema import. */
export interface VersionTwoParts {
  surface?: Surface;
  fonts?: { display?: string };
  ansi?: Ansi;
}

/**
 * Every declaration a theme sets beside its colour tokens: the words its `surface` block names, its
 * display face, then its palette. A part it leaves out sets nothing, so the stylesheet's default holds.
 * The store applies these inline for an imported theme, themes-css.ts writes them into a shipped
 * theme's block, and theme-init.js sets the same ones before first paint.
 */
export function versionTwoDeclarations(theme: VersionTwoParts): Declaration[] {
  const display = theme.fonts?.display;
  return [
    ...surfaceDeclarations(theme.surface),
    ...(display !== undefined && isShippedFont(display) ? displayDeclarations(display) : []),
    ...ansiDeclarations(theme.ansi),
  ];
}

/**
 * The ground of a theme that names none. index.css paints Collie's grain on `:root`, so a theme that
 * leaves `ground` out has to say `flat` itself, or it would inherit the grain. Empty when the theme
 * names a ground word (those declarations come from {@link versionTwoDeclarations}).
 */
export function omittedGroundDeclarations(surface: Surface | undefined): readonly Declaration[] {
  // Only the image: with no image, the size, the ink and the paints draw nothing.
  return surface?.ground === undefined ? [["--ground-image", "none"]] : [];
}

/** Every property {@link versionTwoDeclarations} can set, each once. The store removes these when it takes a theme off. */
export const VERSION_TWO_PROPERTIES: readonly string[] = [...SURFACE_PROPERTIES, ...DISPLAY_PROPERTIES, ...ANSI_PROPERTIES];

/**
 * The table as nested arrays for `public/theme-init.js`: `[[token, [[word, [[property, value]]]]]]`.
 * Arrays and not objects, so the script compares a stored word with each of ours and never looks a
 * stored string up as a key (`constructor` and `__proto__` are keys of every object).
 */
export function surfaceInitTable(): Array<[string, Array<[string, Declaration[]]>]> {
  // The ground is left out: theme-init.js reads it, word or object, from {@link groundInitTable}.
  return SURFACE_TOKENS.filter((token) => token !== "ground").map((token) => [
    token,
    surfaceWords(token).map((word): [string, Declaration[]] => [word, [...wordDeclarations(token, word)]]),
  ]);
}

/**
 * The ground for `public/theme-init.js`: `[[key, [[word, [[property, value]]]], fill]]`, the four keys
 * in order. `fill` is 1 when a key the file leaves out takes its first word, and 0 for the ink, which
 * the pattern already set. The script reads a word ground as `{ pattern: word }`.
 */
export function groundInitTable(): Array<[GroundKey, Array<[string, Declaration[]]>, 0 | 1]> {
  return GROUND_KEYS.map((key) => [key, Object.entries(GROUND_WORDS[key]), key === "ink" ? 0 : 1]);
}

/** The display faces for `public/theme-init.js`: `[[face, [[property, value]]]]`. */
export function displayInitTable(): Array<[string, Declaration[]]> {
  return SHIPPED_FONTS.map((face): [string, Declaration[]] => [face, [...displayDeclarations(face)]]);
}

/** The palette keys for `public/theme-init.js`: `[[key, property]]`. */
export function ansiInitTable(): Array<[string, string]> {
  return ANSI_KEYS.map((key): [string, string] => [key, ansiProperty(key)]);
}

/**
 * The one generated line of `public/theme-init.js`, indented as it stands in the file: the word table,
 * the display faces and the palette keys.
 */
export const SURFACE_INIT_LINE = `  var SURFACE = ${JSON.stringify(surfaceInitTable())}, GROUND = ${JSON.stringify(groundInitTable())}, DISPLAY = ${JSON.stringify(displayInitTable())}, ANSI = ${JSON.stringify(ansiInitTable())};`;

/** The comment line in `public/theme-init.js` that the generated line follows. */
export const SURFACE_INIT_MARKER =
  "  // generated by scripts/build-themes.ts from web/src/lib/theme/surface.ts, do not edit";

/**
 * `theme-init.js` with the line after the marker replaced by `SURFACE_INIT_LINE`, or `undefined`
 * when the file has no marker. The build script writes the result; the test compares it with the file.
 */
export function withSurfaceInitLine(init: string): string | undefined {
  const lines = init.split("\n");
  const at = lines.indexOf(SURFACE_INIT_MARKER);
  if (at < 0 || at + 1 >= lines.length) return undefined;
  lines[at + 1] = SURFACE_INIT_LINE;
  return lines.join("\n");
}

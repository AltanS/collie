// The shape of a theme, schema version 2 (M57 specs 14 and 17): ten tokens, each a CLOSED list of
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
// others through var(); the ten tokens are the ones that end in a property a utility reads at run time.
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
//     bar and the bottom bar. `page` is today's page colour and rule; `band` is `--secondary` with a
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
//
// EVERY DEFAULT IS TODAY'S VALUE. `src/themes/themes.test.ts` reads index.css and Tailwind's own
// theme.css and holds each default word equal to what the app drew before version 2.
//
// It imports one leaf file, for the same reason `schema.ts` imports little: the build script loads it
// with plain Bun.

import { SHIPPED_FONTS, isShippedFont, type ShippedFont } from "../shipped-fonts";

/** The ten shape tokens, in the order a file's words are applied. */
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

/** The bottom colour of the `gradient` ground: the page with 12 percent of the theme's primary. */
export const GROUND_GRADIENT_END = { base: "background", mix: "primary", percent: 12 } as const;
/** The line colour of the `grain` ground: the page with 4 percent of the theme's foreground (6 until
 *  spec 18: at 6 a rule on the light grain measured 1.32 and a dashed ring was lost in it). */
export const GROUND_GRAIN_LINE = { base: "background", mix: "foreground", percent: 4 } as const;

/** `color-mix(in oklab, ...)` of one of the two ground colours above, spelled in CSS. */
function groundMix(m: { base: string; mix: string; percent: number }): string {
  return `color-mix(in oklab, var(--${m.base}) ${100 - m.percent}%, var(--${m.mix}))`;
}

const GRAIN_LINES = `${groundMix(GROUND_GRAIN_LINE)} 0 1px, transparent 1px 4px`;

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
    default: shadows(SHADOW.sm, SHADOW.xs, SHADOW.sm, SHADOW.md, SHADOW.lg, SHADOW.xl, SHADOW["2xl"]),
    flat: shadows(NONE, NONE, NONE, NONE, NONE, NONE, NONE),
    lifted: shadows(SHADOW.md, SHADOW.sm, SHADOW.md, SHADOW.lg, SHADOW.xl, SHADOW["2xl"], SHADOW_3XL),
  },
  density: {
    default: [["--spacing", "0.25rem"]],
    roomy: [["--spacing", "0.28rem"]],
  },
  weight: {
    default: [
      ["--font-weight-medium", "500"],
      ["--font-weight-semibold", "600"],
    ],
    bold: [
      ["--font-weight-medium", "600"],
      ["--font-weight-semibold", "700"],
    ],
  },
  border: {
    default: [["--surface-border-width", "1px"]],
    strong: [["--surface-border-width", "2px"]],
  },
  ground: {
    flat: [["--ground-image", "none"]],
    gradient: [["--ground-image", `linear-gradient(to bottom, var(--background), ${groundMix(GROUND_GRADIENT_END)})`]],
    grain: [
      [
        "--ground-image",
        `repeating-linear-gradient(45deg, ${GRAIN_LINES}), repeating-linear-gradient(-45deg, ${GRAIN_LINES})`,
      ],
    ],
  },
  chrome: {
    page: [
      ["--band-ground", "var(--background)"],
      ["--band-rule", "var(--rule)"],
    ],
    band: [
      ["--band-ground", "var(--secondary)"],
      ["--band-rule", "var(--border)"],
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
    caps: [
      ["--label-transform", "uppercase"],
      ["--label-tracking", "0.025em"],
    ],
    sentence: [
      ["--label-transform", "none"],
      ["--label-tracking", "normal"],
    ],
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
  ground?: SurfaceWord<"ground">;
  chrome?: SurfaceWord<"chrome">;
  rows?: SurfaceWord<"rows">;
  icons?: SurfaceWord<"icons">;
  labels?: SurfaceWord<"labels">;
}

/** The word each token has when a file does not name one: today's look. */
export const SURFACE_DEFAULTS = {
  radius: "sharp",
  shadow: "default",
  density: "default",
  weight: "default",
  border: "default",
  ground: "flat",
  chrome: "page",
  rows: "rules",
  icons: "default",
  labels: "caps",
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
  if (surface.ground !== undefined) out.push(...wordDeclarations("ground", surface.ground));
  if (surface.chrome !== undefined) out.push(...wordDeclarations("chrome", surface.chrome));
  if (surface.rows !== undefined) out.push(...wordDeclarations("rows", surface.rows));
  if (surface.icons !== undefined) out.push(...wordDeclarations("icons", surface.icons));
  if (surface.labels !== undefined) out.push(...wordDeclarations("labels", surface.labels));
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

/** Every property {@link versionTwoDeclarations} can set, each once. The store removes these when it takes a theme off. */
export const VERSION_TWO_PROPERTIES: readonly string[] = [...SURFACE_PROPERTIES, ...DISPLAY_PROPERTIES, ...ANSI_PROPERTIES];

/**
 * The table as nested arrays for `public/theme-init.js`: `[[token, [[word, [[property, value]]]]]]`.
 * Arrays and not objects, so the script compares a stored word with each of ours and never looks a
 * stored string up as a key (`constructor` and `__proto__` are keys of every object).
 */
export function surfaceInitTable(): Array<[string, Array<[string, Declaration[]]>]> {
  return SURFACE_TOKENS.map((token) => [
    token,
    surfaceWords(token).map((word): [string, Declaration[]] => [word, [...wordDeclarations(token, word)]]),
  ]);
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
export const SURFACE_INIT_LINE = `  var SURFACE = ${JSON.stringify(surfaceInitTable())}, DISPLAY = ${JSON.stringify(displayInitTable())}, ANSI = ${JSON.stringify(ansiInitTable())};`;

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

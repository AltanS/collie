// The shape of a theme, schema version 2 (M57 spec 14): five tokens, each a CLOSED list of words,
// and the one table that turns a word into CSS declarations.
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
// others through var(); the five tokens are the ones that end in a property a utility reads at run time.
//   * radius: `--radius-sm/md/lg/xl`. index.css declares them in `@theme` (not `@theme inline`), so
//     `rounded-md` compiles to `border-radius: var(--radius-md)`. Bare `rounded` and `rounded-full`
//     are not steps and never move.
//   * shadow: Tailwind copies a shadow's value into the utility, so index.css points each step the app
//     uses at a property of its own (`--shadow-md: var(--surface-shadow-md)`), and the word sets those.
//   * density: `--spacing`, the step every `p-*`, `gap-*`, `h-*` and `size-*` multiplies. Icons and
//     the header mark box are pinned to the default step in index.css, so they do not grow.
//   * weight: `--font-weight-medium` and `--font-weight-semibold`, the two weights the app draws.
//   * border: Tailwind's `--default-border-width`, the width of a bare `border`, `border-t` and
//     `divide-*`. index.css points it at `--surface-border-width`, the same way as the shadows.
//
// EVERY DEFAULT IS TODAY'S VALUE. `src/themes/themes.test.ts` reads index.css and Tailwind's own
// theme.css and holds each default word equal to what the app drew before version 2.
//
// It imports nothing, for the same reason `schema.ts` imports little: the build script loads it
// with plain Bun.

/** The five shape tokens, in the order a file's words are applied. */
export const SURFACE_TOKENS = ["radius", "shadow", "density", "weight", "border"] as const;

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

function radii(sm: number, md: number, lg: number, xl: number): Declaration[] {
  return [
    ["--radius-sm", `${sm}px`],
    ["--radius-md", `${md}px`],
    ["--radius-lg", `${lg}px`],
    ["--radius-xl", `${xl}px`],
  ];
}

/**
 * The table. Per token, its words in the order Settings lists them, the default first, and the
 * declarations each word sets. Every word of a token sets the SAME properties, so switching from one
 * theme to another always overwrites what the last one set.
 */
export const SURFACE = {
  radius: {
    sharp: radii(2, 2, 2, 2),
    soft: radii(4, 6, 8, 12),
    round: radii(8, 12, 16, 24),
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
} as const satisfies { [T in SurfaceToken]: Record<string, readonly Declaration[]> };

export type SurfaceWord<T extends SurfaceToken> = keyof (typeof SURFACE)[T] & string;

/** A theme's shape: one word per token it sets. A token it leaves out is the default word. */
export interface Surface {
  radius?: SurfaceWord<"radius">;
  shadow?: SurfaceWord<"shadow">;
  density?: SurfaceWord<"density">;
  weight?: SurfaceWord<"weight">;
  border?: SurfaceWord<"border">;
}

/** The word each token has when a file does not name one: today's look. */
export const SURFACE_DEFAULTS = {
  radius: "sharp",
  shadow: "default",
  density: "default",
  weight: "default",
  border: "default",
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

/** The one generated line of `public/theme-init.js`, indented as it stands in the file. */
export const SURFACE_INIT_LINE = `  var SURFACE = ${JSON.stringify(surfaceInitTable())};`;

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

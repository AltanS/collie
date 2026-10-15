// The shipped UI faces, in a file of their own that imports nothing.
//
// `design.ts` owns the face setting and re-exports this list, so every app import still reads it
// from there. The list lives here because the theme schema (`lib/theme/schema.ts`) checks a
// theme's `fonts.ui` against it, and that module must load without a DOM, without React and
// without the `@/` alias: the build script at the collie root and, later, the bridge import it.
// `design.ts` pulls in all three, so the list moved one step down and still has one home.

/**
 * The shipped faces, and the only strings that may ever become a class name.
 *
 * A CLOSED LIST, checked on both the pre-paint path and the app's. The stored value is attacker-
 * adjacent in exactly one narrow sense: it is a string from localStorage that is about to be
 * concatenated into `classList.add()`, and a closed list is the answer that cannot be got wrong,
 * where a sanitiser is one someone has to keep right.
 *
 * `aldrich` is the DEFAULT and adds no class at all: no class means the `--font-sans` already in
 * index.css's @theme block, which is the stack index.html preloads. A device that never opens the
 * setting runs no JavaScript before its first paint.
 */
export const SHIPPED_FONTS = ["system", "grotesk", "aldrich", "plex", "geist", "atkinson"] as const;

export type ShippedFont = (typeof SHIPPED_FONTS)[number];

/** True for a shipped key. Total over any string, which is the whole reason it exists. */
export function isShippedFont(value: string): value is ShippedFont {
  return SHIPPED_FONTS.some((font) => font === value);
}

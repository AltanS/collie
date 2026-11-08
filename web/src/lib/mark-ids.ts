// The logos Collie can draw in its header, as a closed word list. A leaf file with no imports, like
// `shipped-fonts.ts`, because three readers need the same list and two of them must not load React:
// the theme schema (`theme/schema.ts`, which `collie theme check` and the build script import), the
// design store (`design.ts`) and the host component (`components/brand-mark.tsx`).
//
// The ids are fixed. A theme file names one with the top-level key `mark` (version 4), and a device
// may name one in Settings. Nothing else about a mark is a setting: the drawings are generated files
// (`components/<id>-mark.tsx`), and the favicon, the app icon and the splash stay the Collie mark.
//
// ADDING A MARK is one row in the table below, one `case` in `loadChunk` (components/brand-mark.tsx,
// where the compiler names the missing case) and the generated file. The word list, the display name,
// the animation prefix, Settings, the theme schema and the vite chunk folder follow from those.

/**
 * Every mark, in the order Settings lists them. `prefix` is the start of the mark's private CSS
 * keyframe and class names, without the hyphen (`cm` for `cm-t0`); the conformance suite holds each mark
 * to it so no name leaks into another mark or the page.
 */
export const MARKS = [
  { id: "collie", name: "Collie", prefix: "cm" },
  { id: "kawaii", name: "Kawaii", prefix: "ck" },
  { id: "kawaii-tilt", name: "Kawaii Tilt", prefix: "ct" },
  { id: "pixel", name: "Pixel", prefix: "cp" },
] as const;

export type MarkId = (typeof MARKS)[number]["id"];

/** The ids, in the table's order. */
export const MARK_IDS: readonly MarkId[] = MARKS.map((mark) => mark.id);

/** The mark a device wears when neither it nor the theme names one. */
export const DEFAULT_MARK_ID: MarkId = "collie";

/** The display name of a mark. Proper nouns, so they are not translated. */
export function markName(id: MarkId): string {
  const found = MARKS.find((mark) => mark.id === id);
  if (found === undefined) throw new Error(`no mark ${id}`);
  return found.name;
}

/** True for one of the fixed ids. Total: any string. */
export function isMarkId(value: string): value is MarkId {
  return MARKS.some((mark) => mark.id === value);
}

// The logos Collie can draw in its header, as a closed word list. A leaf file with no imports, like
// `shipped-fonts.ts`, because three readers need the same list and two of them must not load React:
// the theme schema (`theme/schema.ts`, which `collie theme check` and the build script import), the
// design store (`design.ts`) and the host component (`components/brand-mark.tsx`).
//
// The ids are fixed. A theme file names one with the top-level key `character` (version 4), and a device
// may name one in Settings > Appearance > Character (ADR 0136, amended 2026-11-12). Nothing else about a mark is a setting: the drawings are generated files
// (`components/<id>-mark.tsx`), and the favicon, the app icon and the splash stay the Collie mark.
//
// ADDING A MARK is one row in the table below, one `case` in `loadChunk` (components/brand-mark.tsx,
// where the compiler names the missing case) and the generated file. The word list, the display name,
// the animation prefix, Settings, the theme schema and the vite chunk folder follow from those. Every
// mark keeps the one contract (`components/mark-contract.ts`, ADR 0148 rule 7): a mark that wants its own
// turn pace gives it up, because the turn table is one table, and a mark that needs a state the contract
// does not cover gets it by a change of the contract in collie-brand, never by a state of its own.
//
// A FAMILY is a set of marks that are one drawing with a different head (the Collie mark and its two
// coat variants). They share one generated stylesheet byte for byte, so they share one `prefix` and its
// keyframe names ON PURPOSE. Every other mark is a family of its own, so its family is its own id.

/**
 * Every mark, in the order Settings lists them. `prefix` is the start of the mark's private CSS
 * keyframe and class names, without the hyphen (`cm` for `cm-t0`); the conformance suite holds each mark
 * to it so no name leaks into another mark or the page. `family` names the marks that share one
 * stylesheet and so one prefix: prefixes are unique across families, not across marks.
 */
export const MARKS = [
  { id: "collie", name: "Collie", prefix: "cm", family: "collie" },
  { id: "collie-collar", name: "Collie with collar", prefix: "cm", family: "collie" },
  { id: "collie-blaze", name: "Collie with blaze", prefix: "cm", family: "collie" },
  { id: "kawaii", name: "Kawaii", prefix: "ck", family: "kawaii" },
  { id: "kawaii-tilt", name: "Kawaii Tilt", prefix: "ct", family: "kawaii-tilt" },
  { id: "pixel", name: "Pixel", prefix: "cp", family: "pixel" },
  { id: "glass", name: "Glass", prefix: "cg", family: "glass" },
  { id: "glass-front", name: "Glass Front", prefix: "ch", family: "glass-front" },
  { id: "sheep", name: "Sheep", prefix: "cs", family: "sheep" },
  { id: "owl", name: "Owl", prefix: "co", family: "owl" },
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

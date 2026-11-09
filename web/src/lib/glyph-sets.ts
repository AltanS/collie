// The glyph sets a theme can name, as a closed word list. A leaf file with no imports, like
// `mark-ids.ts`, because three readers need the same list and two of them must not load React: the
// theme schema (`theme/schema.ts`, which `collie theme check` imports), the Vite plugin that builds
// the set chunks (`web/vite-glyphs.ts`) and the icon host (`components/icons/glyphs.ts`).
//
// A theme names one with the top-level key `glyphs` (version 4). Nothing else picks a set: there is no
// device switch, so the worn theme decides, the theme on trial first (ADR 0137).
//
// ADDING A SET is one row below, one `case` in `loadChunk` (components/icons/glyphs.ts, where the
// compiler names the missing case), one entry in the plugin's table and, for a new family, a map
// under `components/icons/sets/`.

/**
 * Every set, in the order the docs list them. `family` is the icon family the set draws from;
 * `kind` says whether its glyphs are stroked (and take the theme's icon weight) or filled.
 */
export const GLYPH_SETS = [
  { id: "lucide", name: "Lucide", family: "lucide", kind: "stroke" },
  { id: "phosphor", name: "Phosphor", family: "phosphor", kind: "fill" },
  { id: "phosphor-fill", name: "Phosphor Fill", family: "phosphor", kind: "fill" },
  { id: "phosphor-duotone", name: "Phosphor Duotone", family: "phosphor", kind: "fill" },
  { id: "iconoir", name: "Iconoir", family: "iconoir", kind: "stroke" },
] as const;

export type GlyphSetId = (typeof GLYPH_SETS)[number]["id"];

/** The ids, in the table's order. */
export const GLYPH_SET_IDS: readonly GlyphSetId[] = GLYPH_SETS.map((set) => set.id);

/** The set the app draws when the worn theme names none: today's look. */
export const DEFAULT_GLYPH_SET: GlyphSetId = "lucide";

/** The display name of a set. Proper nouns, so they are not translated. */
export function glyphSetName(id: GlyphSetId): string {
  const found = GLYPH_SETS.find((set) => set.id === id);
  if (found === undefined) throw new Error(`no glyph set ${id}`);
  return found.name;
}

/** True for one of the fixed ids. Total: any string. */
export function isGlyphSetId(value: string): value is GlyphSetId {
  return GLYPH_SETS.some((set) => set.id === value);
}

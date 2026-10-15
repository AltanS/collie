// The header marks Collie ships, in a file of their own that imports nothing.
//
// A theme may name one of these as its `mark` (M57 spec 09). The list is closed for the same reason
// `SHIPPED_FONTS` is: the value comes from a file a person downloaded, and it picks a component out of
// a static registry (`components/marks/index.ts`). A closed list is the answer that cannot be got
// wrong. It lives here, with no imports, because the theme schema (`lib/theme/schema.ts`) checks a
// file against it and that module must load without a DOM, without React and without the `@/` alias.
//
// The ids are the shipped theme ids, one to one. `collie` is the dog and the default: a theme file
// without `mark` draws it.

/** The shipped marks. The first is the default. */
export const SHIPPED_MARKS = ["collie", "nightwatch", "daylight", "harbour"] as const;

export type ShippedMark = (typeof SHIPPED_MARKS)[number];

/** The mark a theme draws when its file names none. */
export const DEFAULT_MARK: ShippedMark = "collie";

/** True for a shipped mark id. Total over any value, which is the whole reason it exists. */
export function isShippedMark(value: string): value is ShippedMark {
  return SHIPPED_MARKS.some((mark) => mark === value);
}

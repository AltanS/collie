// The pure half of the Typeface card (web/src/components/typeface-control.tsx; ADR 0033): which value
// the select shows, which note sits under it, and what a pick writes.
//
// web/'s `lib/design.ts` is reused for the shipped list, the class rule and `parseDesignPrefs` (via
// `lib/prefs.ts`), and `lib/operator-fonts.ts` for the validation of operator faces. Only the store
// and the hook around them are replaced here, because those are React.
import { DEFAULT_FONT, isDesignFont } from "@web/lib/design";
import {
  acceptOperatorFonts,
  findOperatorFont,
  OPERATOR_FONT_PREFIX,
  type OperatorFontFace,
} from "@web/lib/operator-fonts";
import type { OperatorFontRow } from "@web/lib/types";

import type { DesignPrefs } from "../../lib/prefs";

/** The value the select can actually show: the stored one, or the default when it resolves to nothing. */
export function shownFont(font: string, faces: readonly OperatorFontFace[]): string {
  if (!font.startsWith(OPERATOR_FONT_PREFIX)) return font;
  return findOperatorFont(font, faces) === null ? DEFAULT_FONT : font;
}

export type TypefaceNote =
  | "settings.typeface.note.system"
  | "settings.typeface.note.grotesk"
  | "settings.typeface.note.aldrich"
  | "settings.typeface.note.operator";

export function noteKey(font: string): TypefaceNote {
  if (font === "system") return "settings.typeface.note.system";
  if (font === "grotesk") return "settings.typeface.note.grotesk";
  if (font === "aldrich") return "settings.typeface.note.aldrich";
  return "settings.typeface.note.operator";
}

/**
 * What a pick stores, or null for a value the select could not have offered. An operator face is
 * looked up in the CURRENT list, so the row mirrored into storage is one this client accepted, never
 * one rebuilt from the select's own string.
 */
export function pickedDesign(value: string, faces: readonly OperatorFontFace[]): DesignPrefs | null {
  if (!isDesignFont(value)) return null;
  const face = findOperatorFont(value, faces);
  return face === null ? { font: value } : { font: value, operatorFont: face };
}

/** The bridge's rows through the client's own validation, keeping the same array while the rows are the same. */
export function acceptedFaces(rows: readonly OperatorFontRow[] | undefined, previous: readonly OperatorFontFace[]): readonly OperatorFontFace[] {
  const next = acceptOperatorFonts(rows ?? []);
  return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
}

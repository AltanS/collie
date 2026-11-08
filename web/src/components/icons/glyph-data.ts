import type { IconNode } from "lucide-react";

import type { IconKey } from "./keys";

// The shape of one glyph set chunk, as `web/vite-glyphs.ts` builds it and `glyphs.ts` loads it.

/** One glyph: lucide's element list, `[tag, attributes][]`, flat, drawn by lucide-react's `Icon`. */
export type GlyphNode = IconNode;

export interface GlyphSetData {
  /** The set's id (`lib/glyph-sets.ts`). */
  id: string;
  /** Attributes on the `<svg>` that differ from lucide's defaults (a fill set's viewBox and fill). */
  root: Readonly<Record<string, string>>;
  /** The glyph of each key the family draws. A key that is absent draws its lucide glyph. */
  glyphs: Readonly<Partial<Record<IconKey, GlyphNode>>>;
}

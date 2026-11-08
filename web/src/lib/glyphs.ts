import { DEFAULT_GLYPH_SET, type GlyphSetId } from "@/lib/glyph-sets";
import { knownGlyphs, type Theme } from "@/lib/theme/schema";
import { activeTheme, useActiveTheme } from "@/lib/theme/store";
import { currentTrial, useTrial } from "@/lib/theme/trial";

// WHICH GLYPH SET THE APP DRAWS. One rule, in one place, read by every icon (`components/icons/icon.tsx`)
// and by the startup preload (`main.tsx`), so the two never disagree about which chunk to fetch. The
// same rule as the header mark (`mark.ts`):
//
//   1. The `glyphs` of the theme the app is wearing, when this Collie has that set (`knownGlyphs`: a
//      newer Collie's set is kept in the theme and drawn here as lucide). A theme being TRIED (`theme/trial.ts`) is the one
//      worn, so it wins over the stored theme while the ribbon is up, even when it names no set.
//   2. Lucide.
//
// There is no device setting. A glyph set is a goodie for whoever writes a theme, so the theme file is
// the only place that names one (ADR 0137). A caller that must not follow the theme (the theme preview
// draws the previewed file's set) passes `set` to `Icon` instead.

export interface GlyphSources {
  /** The theme being tried in this tab, or null. */
  trial: Theme | null;
  /** The stored theme on screen, shipped or imported. */
  active: Theme;
}

/** The set to draw: the worn theme's `glyphs`, else lucide. Pure. */
export function resolveGlyphSetId({ trial, active }: GlyphSources): GlyphSetId {
  const worn = trial ?? active;
  return knownGlyphs(worn) ?? DEFAULT_GLYPH_SET;
}

/** The set to draw now, read once. For code that is not a component. */
export function currentGlyphSetId(): GlyphSetId {
  return resolveGlyphSetId({ trial: currentTrial()?.theme ?? null, active: activeTheme().theme });
}

/** The set to draw, reactive to the stored theme and a trial. */
export function useGlyphSetId(): GlyphSetId {
  const trial = useTrial()?.theme ?? null;
  const active = useActiveTheme().theme;
  return resolveGlyphSetId({ trial, active });
}

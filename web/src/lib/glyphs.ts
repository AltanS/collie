import { useSyncExternalStore } from "react";

import { DEFAULT_GLYPH_SET, type GlyphSetId } from "@/lib/glyph-sets";
import { knownGlyphs, type Theme } from "@/lib/theme/schema";
import { activeTheme, subscribeThemeStore } from "@/lib/theme/store";
import { currentTrial, subscribeTrial } from "@/lib/theme/trial";

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

/** The set of the stored theme, read once, whatever a trial wears: the set Back from a trial returns to. */
export function storedGlyphSetId(): GlyphSetId {
  return resolveGlyphSetId({ trial: null, active: activeTheme().theme });
}

function subscribeGlyphSetId(fn: () => void): () => void {
  const stopStore = subscribeThemeStore(fn);
  const stopTrial = subscribeTrial(fn);
  return () => {
    stopStore();
    stopTrial();
  };
}

/**
 * The set to draw, reactive to the stored theme and a trial. The snapshot is the set's id, a string,
 * so a change that leaves the id alone (a library add, a font, another theme drawn in the same set)
 * never re-renders an icon: React compares the id, not the theme object behind it.
 */
export function useGlyphSetId(): GlyphSetId {
  return useSyncExternalStore(subscribeGlyphSetId, currentGlyphSetId, currentGlyphSetId);
}

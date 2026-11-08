import { DEFAULT_MARK_ID, type MarkId } from "@/lib/mark-ids";
import type { Theme } from "@/lib/theme/schema";
import { activeTheme, useActiveTheme } from "@/lib/theme/store";
import { currentTrial, useTrial } from "@/lib/theme/trial";

// WHICH HEADER MARK THE APP DRAWS. One rule, in one place, read by the header (`BrandMark`) and by the
// startup preload (`main.tsx`), so the two can never disagree about which drawing to fetch.
//
//   1. The `character` of the theme the app is wearing. A theme being TRIED (`theme/trial.ts`) is the one
//      worn, so it wins over the stored theme for as long as the ribbon is up, even when it names no
//      character: trying a theme means seeing that theme, not the stored theme's logo on its colours.
//   2. The Collie mark.
//
// There is no device setting. A character is a goodie for whoever writes a theme, so the theme file
// is the only place that names one (ADR 0136).
//
// The favicon, the home-screen icon, the boot splash, the idle lock, the agent-start handoff and the
// tour stay the Collie mark whatever this returns. They do not call it.

export interface MarkSources {
  /** The theme being tried in this tab, or null. */
  trial: Theme | null;
  /** The stored theme on screen, shipped or imported. */
  active: Theme;
}

/** The mark to draw: the worn theme's character, else Collie. Pure. */
export function resolveMarkId({ trial, active }: MarkSources): MarkId {
  const worn = trial ?? active;
  return worn.character ?? DEFAULT_MARK_ID;
}

/** The mark to draw now, read once. For code that is not a component. */
export function currentMarkId(): MarkId {
  return resolveMarkId({ trial: currentTrial()?.theme ?? null, active: activeTheme().theme });
}

/** The mark to draw, reactive to the stored theme and a trial. */
export function useMarkId(): MarkId {
  const trial = useTrial()?.theme ?? null;
  const active = useActiveTheme().theme;
  return resolveMarkId({ trial, active });
}

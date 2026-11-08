import { designPrefs, useDesignPrefs } from "@/lib/design";
import { DEFAULT_MARK_ID, type MarkId } from "@/lib/mark-ids";
import type { Theme } from "@/lib/theme/schema";
import { activeTheme, useActiveTheme } from "@/lib/theme/store";
import { currentTrial, useTrial } from "@/lib/theme/trial";

// WHICH HEADER MARK THE APP DRAWS. One rule, in one place, read by the header (`BrandMark`) and by the
// startup preload (`main.tsx`), so the two can never disagree about which drawing to fetch.
//
//   1. The device's own choice in Settings > Appearance > Mark, when it is one of the three marks.
//      "From the theme" is the ABSENCE of the field (`design.ts`), so it falls through.
//   2. The `mark` of the theme the app is wearing. A theme being TRIED (`theme/trial.ts`) is the one
//      worn, so it wins over the stored theme for as long as the ribbon is up, even when it names no
//      mark: trying a theme means seeing that theme, not the stored theme's logo on its colours.
//   3. The Collie mark.
//
// The favicon, the home-screen icon, the boot splash, the idle lock, the agent-start handoff and the
// tour stay the Collie mark whatever this returns. They do not call it.

export interface MarkSources {
  /** The device's choice (`DesignPrefs.mark`), absent for "From the theme". */
  device: MarkId | undefined;
  /** The theme being tried in this tab, or null. */
  trial: Theme | null;
  /** The stored theme on screen, shipped or imported. */
  active: Theme;
}

/** The mark to draw: the device's choice, else the worn theme's, else Collie. Pure. */
export function resolveMarkId({ device, trial, active }: MarkSources): MarkId {
  if (device !== undefined) return device;
  const worn = trial ?? active;
  return worn.mark ?? DEFAULT_MARK_ID;
}

/** The mark to draw now, read once. For code that is not a component. */
export function currentMarkId(): MarkId {
  return resolveMarkId({ device: designPrefs().mark, trial: currentTrial()?.theme ?? null, active: activeTheme().theme });
}

/** The mark to draw, reactive to the device choice, the stored theme and a trial. */
export function useMarkId(): MarkId {
  const device = useDesignPrefs().mark;
  const fromTheme = useThemeMarkId();
  return device ?? fromTheme;
}

/** The mark the worn theme alone gives, ignoring the device's choice: what "From the theme" would draw. Reactive. */
export function useThemeMarkId(): MarkId {
  const trial = useTrial()?.theme ?? null;
  const active = useActiveTheme().theme;
  return resolveMarkId({ device: undefined, trial, active });
}

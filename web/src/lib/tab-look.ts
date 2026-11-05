// How the open tab is drawn: the reader of the theme's surface word `tabs` (lib/theme/surface.ts).
//
// `plain` is the look the owner chose for the tab row and the pane row: the open tab differs from
// the rest by ink and weight and nothing else, and the open pane is an inverted pill. `folder` draws
// the open tab as a folder tab (a 3px edge in the theme's `tab-active` colour, a line on each side,
// no line below) that joins the pane row under it, and the open pane as a tinted cell with a ring.
// The word sets no CSS property, as `zoom` does not: the two components read it here and choose
// their classes (components/tab-strip.tsx, pane-strip.tsx, wide-layout.tsx).

import { useActiveTheme } from "@/lib/theme/store";
import type { SurfaceWord } from "@/lib/theme/surface";

export type TabLook = SurfaceWord<"tabs">;

/** The look a theme word names; a theme that leaves it out gets today's `plain`. */
export function tabLook(word: SurfaceWord<"tabs"> | undefined): TabLook {
  return word === "folder" ? "folder" : "plain";
}

/** The look of the theme on screen. */
export function useTabLook(): TabLook {
  return tabLook(useActiveTheme().theme.surface?.tabs);
}

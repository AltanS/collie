// How the composer is laid out: the reader of the theme's surface word `composer`
// (lib/theme/surface.ts). `field` is one text field with its row of controls; `box` is the boxed one. The word sets no CSS
// property, as `zoom` does not; the composer reads it here and chooses its classes.

import type { SurfaceWord } from "@/lib/theme/surface";

/** The layout a theme word names; a theme that leaves it out gets `field` (the theme `collie` names `box` in its file). */
export function composerLayout(word: SurfaceWord<"composer"> | undefined): "field" | "box" {
  return word === "box" ? "box" : "field";
}

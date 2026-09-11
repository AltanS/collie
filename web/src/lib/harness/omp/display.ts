import type { StyledLine } from "../../blocks";

// omp paints tool-card chrome with these near-white paper fills. The mirror is authored in dark
// space and inverted in the app's light theme, so they become solid black bars on a phone. Keep
// the desktop TUI presentation intact and mark only these exact, observed fills. Semantic diff
// backgrounds use different colours and remain untouched — same rule as decorateCodexDisplay.
function isOmpPaperFill(bg: string | undefined): boolean {
  return (
    bg === "rgb(230,236,231)" || bg === "rgb(231,237,244)" || bg === "rgb(229,228,223)"
  );
}

/** Presentation-only pass over omp's raw lines: mark its paper fills for mobile transparency.
 *  Not one byte of visible text changes. The input array is returned as-is when nothing matched,
 *  so a screen omp does not paint this way stays identical, object for object. */
export function decorateOmpDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (!isOmpPaperFill(segment.bg) || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}

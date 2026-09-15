import type { StyledLine } from "../blocks";

// The mirror is authored in dark space and inverted in the app's light theme (ADR 0002), so a LIGHT
// ANSI fill arrives on a phone as a near-black bar. Marking those segments hands them to the
// renderer's mobile-width transparency rule; the desktop TUI presentation is untouched.
//
// Matched by LUMINANCE, never by a palette value. An exact-match list is a list of the fills that
// happened to be seen the day it was written, and it fails silently: nothing in the mirror can say
// that a fill missed by four levels is the bar you are looking at. Rec. 709 luma on 0–255.

/** omp's floor. Its cards are pastel "paper" fills, well above its own dark body. */
export const LIGHT_FILL_LUMA = 180;

/** Codex's floor. Its submitted-message band and composer box are painted near-white; every other
 *  fill in the whole fixture corpus sits at 188 or below, so 220 stands in an empty gap. */
export const NEAR_WHITE_FILL_LUMA = 220;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether a parsed segment background is at or above `floor` — light enough to invert into a bar. */
export function isLightFill(bg: string | undefined, floor: number): boolean {
  if (!bg) return false;
  if (bg === "var(--ansi-15)" || bg === "var(--ansi-7)") return true;
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(bg);
  if (rgb) return luma(+rgb[1]!, +rgb[2]!, +rgb[3]!) >= floor;
  const hex = /^#([0-9a-fA-F]{6})$/.exec(bg);
  if (!hex) return false;
  const n = parseInt(hex[1]!, 16);
  return luma((n >> 16) & 255, (n >> 8) & 255, n & 255) >= floor;
}

/** Presentation-only pass over an agent's raw lines: mark fills at or above `floor` for mobile
 *  transparency. Not one byte of visible text changes, and the input array is returned as-is when
 *  nothing matched — so a screen the agent does not paint this way stays identical, object for
 *  object, and an adapter that changes nothing still proves it by identity. */
export function markLightFills(lines: StyledLine[], floor: number): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (!isLightFill(segment.bg, floor) || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}

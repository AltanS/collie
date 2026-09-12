import type { StyledLine } from "../../blocks";

// Light ANSI fills invert to black bars on a phone (dark-space mirror + CSS invert).
// Dark fills — diffs, body chrome — stay. Rec. 709 luma on 0–255; 180 separates the two.
const LIGHT_FILL_LUMA = 180;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isLightFill(bg: string | undefined): boolean {
  if (!bg) return false;
  if (bg === "var(--ansi-15)" || bg === "var(--ansi-7)") return true;
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(bg);
  if (rgb) return luma(+rgb[1], +rgb[2], +rgb[3]) >= LIGHT_FILL_LUMA;
  const hex = /^#([0-9a-fA-F]{6})$/.exec(bg);
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  return luma((n >> 16) & 255, (n >> 8) & 255, n & 255) >= LIGHT_FILL_LUMA;
}

/** Presentation-only pass over omp's raw lines: mark light fills for mobile transparency.
 *  Not one byte of visible text changes. The input array is returned as-is when nothing matched. */
export function decorateOmpDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (!isLightFill(segment.bg) || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}

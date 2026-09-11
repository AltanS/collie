import type { StyledLine } from "../../blocks";

// Light fills invert to solid black bars on a phone (the mirror is dark-space + CSS invert).
// Dark fills — semantic diffs, body chrome — stay. Rec. 709 luma on 0–255; 180 sits between
// paper/white tool cards (~230–250) and green/red diffs (~30–75). Not a theme list.
const LIGHT_FILL_LUMA = 180;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isLightFill(bg: string | undefined): boolean {
  if (!bg) return false;
  // Indexed bright white / white. Other --ansi-* slots stay (they are the 16-colour palette).
  if (bg === "var(--ansi-15)" || bg === "var(--ansi-7)") return true;
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(bg);
  if (rgb) return luma(+rgb[1], +rgb[2], +rgb[3]) >= LIGHT_FILL_LUMA;
  const hex = /^#([0-9a-fA-F]{6})$/.exec(bg);
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  return luma((n >> 16) & 255, (n >> 8) & 255, n & 255) >= LIGHT_FILL_LUMA;
}

/** Presentation-only pass: mark light ANSI fills for mobile transparency. Not one byte of
 *  visible text changes. Same-reference when nothing matched. */
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

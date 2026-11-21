import { lineText, sliceStyledLine, type StyledLine } from "../../blocks";
import { LIGHT_FILL_LUMA, markLightFills } from "../light-fill";

/** Presentation-only pass over omp's raw lines: mark light fills for mobile transparency. The rule
 *  lives in `../light-fill.ts`, shared with Codex, which hits the same inverted-mirror bar. The
 *  floor is unchanged from the one this adapter shipped with. */
export function decorateOmpDisplay(lines: StyledLine[]): StyledLine[] {
  return markLightFills(lines, LIGHT_FILL_LUMA);
}

// In a shell tool result the named divider separates the command from stdout.
// Only unbox adjacent body rows: a picker's rows have the same padded sides.
const OUTPUT_DIVIDER = /^├─+ Output ─+┤ *$/;

export function prepareOmpDisplay(lines: StyledLine[]): StyledLine[] {
  let out: StyledLine[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.noWrap || !OUTPUT_DIVIDER.test(lineText(line))) continue;
    for (const direction of [-1, 1]) {
      for (let j = i + direction; j >= 0 && j < lines.length; j += direction) {
        const row = lines[j]!;
        if (!row.noWrap) break;
        const text = lineText(row).trimEnd();
        if (!text.startsWith("│ ") || !text.endsWith("│")) break;
        const end = text.slice(0, -1).trimEnd().length;
        out ??= lines.slice();
        out[j] = sliceStyledLine(row, 2, end);
      }
    }
  }
  return out ?? lines;
}

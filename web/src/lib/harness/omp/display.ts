import type { StyledLine } from "../../blocks";
import { LIGHT_FILL_LUMA, markLightFills } from "../light-fill";

/** Presentation-only pass over omp's raw lines: mark light fills for mobile transparency. The rule
 *  lives in `../light-fill.ts`, shared with Codex, which hits the same inverted-mirror bar. The
 *  floor is unchanged from the one this adapter shipped with. */
export function decorateOmpDisplay(lines: StyledLine[]): StyledLine[] {
  return markLightFills(lines, LIGHT_FILL_LUMA);
}

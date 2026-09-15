import type { StyledLine } from "../../blocks";
import { markLightFills, NEAR_WHITE_FILL_LUMA } from "../light-fill";

/** Presentation-only pass over Codex's raw lines: mark the near-white fills it runs to the terminal
 *  edge — the submitted-message band and the composer box — for mobile transparency. The rule lives
 *  in `../light-fill.ts`, shared with omp: it is one fact about the inverted mirror, not a Codex
 *  grammar, and the two adapters differ only in where they put the floor. */
export function decorateCodexDisplay(lines: StyledLine[]): StyledLine[] {
  return markLightFills(lines, NEAR_WHITE_FILL_LUMA);
}

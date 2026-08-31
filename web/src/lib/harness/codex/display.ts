import { lineText, type StyledLine } from "../../blocks";
import { PURE_HORIZONTAL_RULE_GLYPH_CLASS } from "../../rule-glyphs";

const MIN_CODEX_RULE_RUN = 20;
const LONG_CODEX_RULE_RUN = new RegExp(
  `([${PURE_HORIZONTAL_RULE_GLYPH_CLASS}])\\1{${MIN_CODEX_RULE_RUN - 1},}`,
);

// Codex fills submitted user-message rows to the terminal edge with this truecolor background.
// The mirror is authored in dark space and inverted in the app's light theme, so #f0f0f0 becomes
// #0f0f0f: a solid black 195-column bar on a phone. Keep the desktop TUI presentation intact and
// mark only this exact, observed fill for the renderer's mobile-width transparency rule. Semantic
// diff backgrounds use different colours and remain untouched.
const CODEX_USER_MESSAGE_BG = "rgb(240,240,240)";

export function decorateCodexDisplay(lines: StyledLine[]): StyledLine[] {
  return lines.map((line) => {
    const noWrap = line.noWrap || LONG_CODEX_RULE_RUN.test(lineText(line));
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (segment.bg !== CODEX_USER_MESSAGE_BG || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!noWrap && !changedSegments) return line;
    return {
      ...line,
      segments: changedSegments ? segments : line.segments,
      ...(noWrap ? { noWrap: true as const } : {}),
    };
  });
}

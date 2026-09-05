import type { StyledLine } from "../../blocks";

// Codex fills submitted user-message rows to the terminal edge with this truecolor background.
// The mirror is authored in dark space and inverted in the app's light theme, so #f0f0f0 becomes
// #0f0f0f: a solid black 195-column bar on a phone. Keep the desktop TUI presentation intact and
// mark only this exact, observed fill for the renderer's mobile-width transparency rule. Semantic
// diff backgrounds use different colours and remain untouched.
const CODEX_USER_MESSAGE_BG = "rgb(240,240,240)";

/** Presentation-only pass over Codex's raw lines: mark its user-message fill for mobile
 *  transparency. Not one byte of visible text changes. The input array is returned as-is when
 *  nothing matched, so a screen Codex does not paint this way stays identical, object for object. */
export function decorateCodexDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (segment.bg !== CODEX_USER_MESSAGE_BG || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!changedSegments) return line;
    changedLines = true;
    return { ...line, segments };
  });

  return changedLines ? decorated : lines;
}

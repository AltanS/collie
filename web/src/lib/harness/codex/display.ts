import { lineText, type StyledLine } from "../../blocks";
import { PURE_HORIZONTAL_RULE_GLYPH_CLASS } from "../../rule-glyphs";

// A CODEX LABELLED SEPARATOR: a short rule, one label, then a rule that runs to the row's end, as
// in `─ Worked for 3m 12s ─────────────…`. blocks.ts already clips a BARE terminal-width rule
// (PURE_HORIZONTAL_BORDER) and a framed row (FRAME_ROW); this shape falls through both, because the
// label breaks the "one repeated glyph, nothing else" test and the row has no frame edges. Wrapped,
// it lands as a stub of rule glyphs on a second visual row under the label, several times a turn.
//
// The shape is the whole guard. Clipping hides a row's right edge, so the classifier must not fire
// on ordinary output Codex prints: a markdown table, a code block, a diff. Requiring the ENTIRE row
// to be rule / label / rule, with a label that carries no rule glyph of its own, means a row with a
// long rule run somewhere inside it is left to wrap as before.
//
// The two counts are this module's own, and cite no threshold elsewhere (see rule-glyphs.ts: share
// the alphabet, never a predicate or a threshold). The leading run is short by observation, because
// Codex paints one glyph, and four leaves room without admitting a rule that merely has text after
// it. The trailing run is floored at twenty because a shorter row already fits the narrowest
// mirror, so clipping it would buy nothing.
const MAX_LEADING_RULE_RUN = 4;
const MIN_TRAILING_RULE_RUN = 20;
const RULE = PURE_HORIZONTAL_RULE_GLYPH_CLASS;
const LABELLED_RULE_ROW = new RegExp(
  `^\\s*([${RULE}])\\1{0,${MAX_LEADING_RULE_RUN - 1}} +` + // a short leading rule
    `[^${RULE}\\s](?:[^${RULE}]*[^${RULE}\\s])? +` + // the label: no rule glyph, no edge space
    `([${RULE}])\\2{${MIN_TRAILING_RULE_RUN - 1},}\\s*$`, // a rule to the row's end
);

// Codex fills submitted user-message rows to the terminal edge with this truecolor background.
// The mirror is authored in dark space and inverted in the app's light theme, so #f0f0f0 becomes
// #0f0f0f: a solid black 195-column bar on a phone. Keep the desktop TUI presentation intact and
// mark only this exact, observed fill for the renderer's mobile-width transparency rule. Semantic
// diff backgrounds use different colours and remain untouched.
const CODEX_USER_MESSAGE_BG = "rgb(240,240,240)";

/** Presentation-only pass over Codex's raw lines: clip its labelled separators, and mark its
 *  user-message fill for mobile transparency. Not one byte of visible text changes. The input array
 *  is returned as-is when nothing matched, so a screen Codex does not paint this way stays
 *  identical, object for object. */
export function decorateCodexDisplay(lines: StyledLine[]): StyledLine[] {
  let changedLines = false;
  const decorated = lines.map((line) => {
    const noWrap = line.noWrap || LABELLED_RULE_ROW.test(lineText(line));
    let changedSegments = false;
    const segments = line.segments.map((segment) => {
      if (segment.bg !== CODEX_USER_MESSAGE_BG || segment.mobileTransparentBg) return segment;
      changedSegments = true;
      return { ...segment, mobileTransparentBg: true as const };
    });

    if (!changedSegments && noWrap === Boolean(line.noWrap)) return line;
    changedLines = true;
    const next: StyledLine = { ...line, segments: changedSegments ? segments : line.segments };
    if (noWrap) next.noWrap = true;
    return next;
  });

  return changedLines ? decorated : lines;
}

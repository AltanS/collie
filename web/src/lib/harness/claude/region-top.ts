// Where a Claude modal's REGION starts: the upward scan the generic menu grammar (menu.ts) and the
// Effort slider grammar (effort.ts) share.
//
// Claude marks the top of a full-screen modal in one of two ways.
//
//   * A `─` RULE or box border. The scan has always taken the nearest one within REGION_SCAN_WINDOW
//     rows of the footer (any rule-glyph row, isHorizontalRule, or a U+2500 border, isBoxBorder).
//   * The MODAL EDGE. Claude Code 2.1.27x and later open every slash-command modal with a row of
//     U+2594 (`▔`) across the pane, often with a label spliced in near its right end:
//       `▔▔▔…▔ ● high · /effort ▔`, `▔▔▔ You've used 89% of your weekly limit · … ▔`.
//     The labelled form is not a horizontal rule (isHorizontalRule wants rule glyphs only), and a tall
//     modal (`/hooks`, `/config`) puts it 37 rows or more above its footer, past the window. On a live
//     2.1.283 screen with no other rule in reach, both grammars declined and the phone showed the
//     unread-dialog card. The lab corpus passed only because an unrelated transcript rule happened to
//     sit inside the window (`claude-lab--menu-rewind--w82.txt`).
//
// So the region's top is the NEAREST of: a rule within REGION_SCAN_WINDOW, or a modal edge within
// MODAL_EDGE_WINDOW. A U+2500 box border beyond the rule window ends the search: it belongs to
// something drawn before the modal (a box, a transcript separator), so a `▔` above it is not this
// modal's edge.
//
// Pure functions over row texts.

import { displayWidth } from "../../text-width";
import { isBoxBorder, isHorizontalRule } from "./markers";

/** How far above the footer a `─` rule / box border may open the region. Generous enough for a tall
 *  picker, bounded so a borderless buffer can't be claimed unboundedly. */
export const REGION_SCAN_WINDOW = 30;

/** How far above the footer a MODAL EDGE may open the region: the 60-row tail bound the input-box
 *  locator also uses (MAX_TAIL_LINES in chrome.ts). The `/hooks` list puts its edge 37 rows up. */
export const MODAL_EDGE_WINDOW = 60;

// A modal edge: `▔` from column 0, optionally one label spliced in, closed by `▔` again. Nothing
// else: an indented row, or a row that does not end in the glyph, is prose that happens to hold it.
const MODAL_EDGE = /^▔+(?:\s+\S.*?\s+▔+)?$/u;

// The shortest edge worth the name, in display cells. The same floor as a bare input-box border
// (BARE_BORDER_MIN in markers.ts). Every real edge in the corpus spans the pane, 40 cells or more.
const MODAL_EDGE_MIN_WIDTH = 8;

/**
 * Whether row `i` is a MODAL EDGE for a footer at `footerLine`: the `▔` row shape above, at least
 * MODAL_EDGE_MIN_WIDTH cells, and FULL WIDTH, which here means no row between it and the footer is
 * wider. The region's rows are drawn at the pane's current width, so the edge, which spans the pane,
 * is the widest of them. A short `▔` run inside agent output is narrower than the rows under it.
 * Measured against the region alone, not the whole screen, so scrollback drawn at an older pane width
 * cannot disqualify a live edge.
 */
export function isModalEdge(texts: string[], i: number, footerLine: number): boolean {
  const row = texts[i]!.trimEnd();
  if (!MODAL_EDGE.test(row)) return false;
  const width = displayWidth(row);
  if (width < MODAL_EDGE_MIN_WIDTH) return false;
  for (let j = i + 1; j <= footerLine; j++) {
    if (displayWidth(texts[j]!.trimEnd()) > width) return false;
  }
  return true;
}

/** What one row means to the upward region scan (regionTopAt). */
export type RegionTopKind = "edge" | "rule" | "stop";

/**
 * Classify row `i`, `seen` rows above the footer at `footerLine`, for the upward region scan:
 *  - `edge`: a modal edge (isModalEdge), anywhere inside MODAL_EDGE_WINDOW;
 *  - `rule`: a rule or box border inside REGION_SCAN_WINDOW (the rule the scan always took);
 *  - `stop`: a U+2500 box border past REGION_SCAN_WINDOW, which ends the search with no top;
 *  - null: keep scanning.
 * The caller bounds its loop by MODAL_EDGE_WINDOW. Callers with rows of their own to step over (the
 * Effort slider's marker and track rows) test those first, then ask this.
 */
export function regionTopAt(texts: string[], i: number, seen: number, footerLine: number): RegionTopKind | null {
  const t = texts[i]!;
  if (isModalEdge(texts, i, footerLine)) return "edge";
  if (seen < REGION_SCAN_WINDOW) return isBoxBorder(t) || isHorizontalRule(t) ? "rule" : null;
  return isBoxBorder(t) ? "stop" : null;
}

/** The region's opening row, and whether it is a modal edge (`▔`) rather than a `─` rule. */
export interface RegionTop {
  line: number;
  edge: boolean;
}

/** The nearest region top above the footer at `footerLine`, or null (see the header). */
export function findRegionTop(texts: string[], footerLine: number): RegionTop | null {
  for (let i = footerLine - 1, seen = 0; i >= 0 && seen < MODAL_EDGE_WINDOW; i--, seen++) {
    const kind = regionTopAt(texts, i, seen, footerLine);
    if (kind === "stop") return null;
    if (kind !== null) return { line: i, edge: kind === "edge" };
  }
  return null;
}

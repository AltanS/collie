// The AUTHENTICATION BOX — the rounded box Claude Code draws over its input box while the
// `awsAuthRefresh` command runs. It holds its title alone until the command prints, and lifts then as a
// waiting card; once filled it holds that command's output (a login URL and a device code) or, when
// another process already runs it, a one-sentence lock message:
//
//     ╭────────────────────────────╮
//     │ Authentication             │      ← title row, exactly "Authentication"
//     │                            │
//     │ Browser will not be …      │      ← content rows, one padding cell inside each border
//     ╰────────────────────────────╯
//                                         ← blank rows, and at most one turn-spinner row
//     <the live input box>
//
// The box's content width is its own edges' inner width less the padding, never the pane's: a 61-wide
// box on a 61-column pane holds 57 cells, a 113-wide box on a 120-column pane holds 109. Rows are cut
// by that width from the left edge, so the padding is dropped whether the terminal drew it as its own
// styled run or inside the text run, and every other space the row holds stays.
//
// It lifts as a card of its own kind, `box-text`, which prints no key and holds none. Every other card
// above the live box is a `menu` defined by the keys its rows print (ADR 0109), and this box prints
// none. A `menu` with zero actions would be a dialog card, so the composer's "Answer the dialog" would
// point at it while the box under it still takes a message; teaching surface/notice.ts a keyless shape
// would hand the Surface and the bridge's send gate a notice with nothing to bind. So the card has no
// row in harness/dialog-contract.ts, and the composer and the send path stay exactly as they are on
// the same screen without it.
//
// It lifts only while the input box under it is live and its tail reads as Claude's statusline, so a
// completion popup or rows the input frame cannot classify leave the screen as it is. That is the one
// rule, and it is not ADR 0109's: a notice must also keep its binding region inside the bridge's tail
// window, and a card that sends nothing binds nothing. Under a live frame, output rows cannot be told
// from status rows, so the residue is accepted: rows under an exited frame that still walk as a
// statusline tail (up to eight status rows, or those plus a blank-separated footer of up to eight more)
// keep a stale card on screen, whose link at worst opens an expired login page. No keystroke is ever
// at stake.
//
// Pure functions over parsed line text.

import { lineText, type StyledLine } from "../../blocks";
import { findLinks } from "../../links";
import { readCuesFor } from "../../surface/cues";
import { findInputFrame } from "../../surface/frame";
import type { BoxTextModel, BoxTextRun } from "../box-text-model";
import { joinBrokenUrls } from "./box-url-join";
import { inputBoxTail } from "./chrome";
import { CLAUDE_IDLE, isBlank } from "./markers";

const TITLE = "Authentication";
/** The border and its one padding cell, on each side of a row. */
const EDGE_CELLS = 2;

/** A box found above the input box: its rows, `startLine` to `endLine` inclusive, and its card. */
export interface AuthBoxRegion {
  startLine: number;
  endLine: number;
  model: BoxTextModel;
}

function runsOf(content: string): BoxTextRun[] {
  const runs: BoxTextRun[] = [];
  let at = 0;
  for (const link of findLinks(content)) {
    if (link.start > at) runs.push({ kind: "plain", text: content.slice(at, link.start) });
    runs.push({ kind: "link", text: content.slice(link.start, link.end), href: link.href });
    at = link.end;
  }
  if (at < content.length) runs.push({ kind: "plain", text: content.slice(at) });
  return runs;
}

// A message sent while the box is up starts a turn, and Claude Code (2.1.310) draws that turn's spinner
// in the gap under the box while it waits for the login, which is how a prompt that triggers the refresh
// meets the box. The row belongs to the turn, not to a dialog, so the card stays keyless.
const TURN_SPINNER_ROW = /^[·*✢✶✻✽] [^\s…]+…(?: · tool use)?(?: ?\(.*)?$/;

function skipBlankRows(texts: readonly string[], from: number): number {
  let row = from;
  while (row >= 0 && isBlank(texts[row]!)) row--;
  return row;
}

/**
 * The matched rounded-corner box whose bottom edge is the last non-blank row above `before`, or null.
 * One turn-spinner row may stand between the box and `before`.
 */
function boxAbove(texts: readonly string[], before: number): { top: number; bottom: number; width: number } | null {
  let bottom = skipBlankRows(texts, before - 1);
  if (bottom < 0) return null;
  if (TURN_SPINNER_ROW.test(texts[bottom]!.trimEnd())) bottom = skipBlankRows(texts, bottom - 1);
  if (bottom < 0) return null;
  const bottomEdge = texts[bottom]!.trimEnd();
  if (!bottomEdge.startsWith("╰") || !bottomEdge.endsWith("╯")) return null;
  const width = bottomEdge.length;
  for (let row = bottom - 1; row >= 0; row--) {
    const text = texts[row]!.trimEnd();
    if (text.startsWith("╭")) return text.endsWith("╮") && text.length === width ? { top: row, bottom, width } : null;
    if (!text.startsWith("│") || !text.endsWith("│") || text.length !== width) return null;
  }
  return null;
}

/**
 * The Authentication box over Claude's live input box, or null. The card's rows are the box's content
 * rows under the title row, blank rows included; a box holding its title alone, or the title and blank
 * rows, lifts as a waiting card with no rows.
 */
export function detectAuthBox(lines: StyledLine[]): AuthBoxRegion | null {
  if (inputBoxTail(lines) !== "statusline") return null;
  const frame = findInputFrame(lines, CLAUDE_IDLE);
  if (frame === null) return null;
  // A strong cue means a dialog holds the keys. Every screen this refuses is already refused by the
  // statusline tail or by the gap under the box, blank but for one turn-spinner row; it stays as the
  // guard of last resort, so loosening either rule never lifts a card over a dialog.
  if (readCuesFor(lines, frame, CLAUDE_IDLE).strength === "strong") return null;
  const texts = lines.map(lineText);
  const box = boxAbove(texts, frame.top);
  if (box === null) return null;
  const titleRow = box.top + 1;
  if (titleRow === box.bottom) return null;
  // The title row is read up to the right border, so a title that spills into the padding cell is not the title.
  if (texts[titleRow]!.trimEnd().slice(EDGE_CELLS, box.width - 1).trim() !== TITLE) return null;
  const contentWidth = box.width - 2 * EDGE_CELLS;
  const rows = texts.slice(titleRow + 1, box.bottom).map((text) => text.trimEnd().slice(EDGE_CELLS, EDGE_CELLS + contentWidth));
  const model: BoxTextModel = rows.every(isBlank)
    ? { title: TITLE, phase: "waiting", text: [] }
    : { title: TITLE, phase: "filled", text: joinBrokenUrls(rows, contentWidth).map(runsOf) };
  return { startLine: box.top, endLine: box.bottom, model };
}

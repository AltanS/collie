// OmO's side panel (.adr/0098, "The side panel"). In fullscreen mode, on a pane at least 120 columns
// wide, OmO draws a panel (session, context, tools, memory, a path) at the right of the screen, and
// when the panel is taller than the free rows it runs down beside the editor and the dialogs. The
// left side is then exactly as wide as the editor's rules, W columns, and the panel starts at column
// W, often with no space after a rule (pi--omo-v5130-panel-draft.txt):
//
//   ─────────────────────────────────────MEMORY  work-0000
//   ❯ hello collie draft                 facts   4 queued
//   ─────────────────────────────────────
//
// So the reader crops every row at W before it reads the editor or a dialog, when one of three signs
// says the panel is there:
//   a. a rule row (bare, or labelled like a running turn's) carries text straight after its `─` run;
//   b. a row of the frame at the tail runs past the frame's own rules: padded with spaces up to
//      column W, then text. The frame is the section over the status rows, from the bottom rule up
//      to the nearest rule of its width, and, when that section is not an editor, a picker's header
//      section above it. Beside an empty `❯` the panel's path would read as a phantom draft
//      (pi--omo-v5130-panel-phantom.txt), and beside a picker's hints they read as no hint row.
//   c. a dialog taller than the pane: its bottom rule and the status rows are off the screen, so (a)
//      and (b) have no tail to stand on. The lowest rule run is then the frame's top rule, and W
//      counts when the rows cut at W read as an open pi frame (ask.ts `openFrameTop`) and the run
//      goes straight into text, or a row of the frame is padded to W and then carries text.
// A pane without any sign is read exactly as before: no row of an ordinary pane is wider than
// the editor's rules, which span the pane.
//
// Sign (a) is anchored to the frame, because agent output can print a rule run straight into text
// too (a markdown heading, a table, a quoted screen). W counts only when the frame at the tail, read
// cropped at W, has a bottom rule whose own run on the screen is exactly W columns wide, and when one
// sign row is a row of that frame. So the crop width is always the width of the frame's own rules:
// a short rule in the transcript or in a typed draft cannot give a small W. Sign (b) reads W off the
// frame's bottom rule to begin with. All three signs come from OmO 5.1.30 on Linux (Herdr 0.9.3);
// whether Windows ConPTY pads the panel's rows the same way is not verified, and docs/windows.md lists
// pi and OmO under "What is not tested".
//
// A cropped frame is not one the bridge can find as whole screen rows: these carry the panel, and
// the panel ticks (`elapsed 1m21`). So a question read from a cropped frame binds to the frame's
// columns, 0 to W (`PromptModel.bindColumns`, lib/column-range.ts): the bridge cuts its fresh read to
// the same columns before it compares, so the panel's clock does not refuse the tap and a change in
// the dialog does (index.ts). A reply to the editor beside the panel still goes out as an unbound
// write and waits for the read-back before Enter: the composer's bound prompt is whole rows.
//
// Pure, no harness imports beyond the pi readers.
import { lineText, type StyledLine } from "../../blocks";
import { graphemeSegmenter } from "../../env";
import { displayWidth } from "../../text-width";
import { openFrameTop } from "./ask";
import { locateComposer, MAX_PICKER_HEADER_ROWS, ruleAbove, tailRule } from "./composer";
import { keyHintPairs, listDialogHint } from "./footer";

/** How far up from the tail a sign is looked for: the reader's own bound on a dialog. */
const MAX_SCAN_ROWS = 200;
/** A rule run, then text with no space between. A box glyph after the run is a table, not a panel. */
const BARE_SIGN = /^(─{8,})(?=[^\s─-╿])/;
const LABELLED_SIGN = /^(─{2,} \S.*? ─{3,})(?=[^\s─-╿])/;
/** Sign (b): a row padded with at least two spaces up to column W, then text. */
const PADDED_TO_EDGE = / {2}$/;
/** The rule run a row opens with: labelled (a running turn's) or bare. */
const RULE_RUN = /^(?:─{2,} \S.*? ─{3,}|─+)/;

export interface PiView {
  /** The rows the readers see: cropped at the panel's column, or the screen as it is. */
  lines: StyledLine[];
  /** True when the rows were cropped, so nothing read from them binds as whole screen rows. */
  cropped: boolean;
  /** The panel's column, W, when `cropped`: every row was cut to its first W display columns. */
  column: number | null;
}

/** The column OmO's side panel starts at, or null when no sign says it is there. */
export function panelColumn(lines: StyledLine[]): number | null {
  const texts = lines.map((line) => lineText(line).trimEnd());
  // Sign (a): every width a rule run gives, with the rows that give it, nearest the tail first.
  const signs = new Map<number, number[]>();
  for (let r = texts.length - 1; r >= 0 && texts.length - r <= MAX_SCAN_ROWS; r--) {
    const m = BARE_SIGN.exec(texts[r]!) ?? LABELLED_SIGN.exec(texts[r]!);
    if (m === null) continue;
    const width = displayWidth(m[1]!);
    signs.set(width, [...(signs.get(width) ?? []), r]);
  }
  for (const [width, rows] of signs) if (anchored(lines, texts, width, rows)) return width;
  return overrunColumn(lines, texts) ?? openColumn(lines, texts);
}

/**
 * Sign (c): a dialog taller than the pane, so its bottom rule and the status rows are off the screen
 * and signs (a) and (b), which start from the status rows, have nothing to stand on. The lowest row
 * that opens with a rule run is then the frame's top rule, W is that run's width, and W counts only
 * when the screen cut at W reads as an open pi frame (ask.ts `openFrameTop`) and the panel shows:
 * the run goes straight into text, or a row of the frame (or of a picker's header above it) is
 * padded to W and then carries text. Read off cuts of real captures (fixtures README, "derived").
 */
function openColumn(lines: StyledLine[], texts: string[]): number | null {
  if (tailRule(lines) !== null) return null;
  let end = texts.length - 1;
  while (end >= 0 && texts[end] === "") end--;
  for (let r = end; r >= 0 && end - r <= MAX_SCAN_ROWS; r--) {
    const run = /^─{8,}/.exec(texts[r]!);
    if (run === null) continue;
    const width = displayWidth(run[0]);
    if (!mayBeOpenFrame(lines, texts, r, end, width)) return null;
    // Only the frame's window is cut: the rule, a picker's header section above it, the rows below.
    const from = Math.max(0, r - MAX_PICKER_HEADER_ROWS - 1);
    const cropped = lines.slice(from, end + 1).map((line) => cropLine(line, width));
    const croppedTexts = cropped.map((line) => lineText(line).trimEnd());
    if (openFrameTop(cropped, croppedTexts, end - from) !== r - from) return null;
    if (BARE_SIGN.test(texts[r]!)) return width;
    const header = ruleAbove(croppedTexts, r - from, croppedTexts[r - from]!.length, MAX_PICKER_HEADER_ROWS + 1);
    for (let row = header < 0 ? r : header + from; row <= end; row++) {
      const value = texts[row]!;
      if (displayWidth(value) <= width) continue;
      const left = cropText(value, width);
      if (PADDED_TO_EDGE.test(left) && value.slice(left.length).trim() !== "") return width;
    }
    return null;
  }
  return null;
}

/** Sign (a) holds at `width` only for the frame at the tail: its bottom rule's run on the screen is
 *  exactly `width` wide, and one of `rows` is a row of that frame. */
function anchored(lines: StyledLine[], texts: string[], width: number, rows: number[]): boolean {
  const cropped = lines.map((line) => cropLine(line, width));
  const tail = tailRule(cropped);
  if (tail === null) return false;
  const run = RULE_RUN.exec(texts[tail.bottom]!);
  if (run === null || displayWidth(run[0]) !== width) return false;
  const croppedTexts = cropped.map((line) => lineText(line).trimEnd());
  const rule = croppedTexts[tail.bottom]!.length;
  const top = ruleAbove(croppedTexts, tail.bottom, rule, MAX_SCAN_ROWS);
  const header = top >= 0 && locateComposer(cropped) === null ? ruleAbove(croppedTexts, top, rule, MAX_PICKER_HEADER_ROWS + 1) : -1;
  const start = header >= 0 ? header : top >= 0 ? top : tail.bottom;
  return rows.some((r) => r >= start && r < tail.end);
}

/** Sign (b): a row of the tail frame runs past the frame's rules. */
function overrunColumn(lines: StyledLine[], texts: string[]): number | null {
  const tail = tailRule(lines);
  if (tail === null) return null;
  const rule = texts[tail.bottom]!;
  const top = ruleAbove(texts, tail.bottom, rule.length, MAX_SCAN_ROWS);
  if (top < 0) return null;
  const header = locateComposer(lines) === null ? ruleAbove(texts, top, rule.length, MAX_PICKER_HEADER_ROWS + 1) : -1;
  const width = displayWidth(rule);
  for (let r = header < 0 ? top : header; r < tail.end; r++) {
    const row = texts[r]!;
    if (displayWidth(row) <= width) continue;
    const left = cropText(row, width);
    if (PADDED_TO_EDGE.test(left) && row.slice(left.length).trim() !== "") return width;
  }
  return null;
}

/** Some visible segment painted: how pi draws a dialog's title. */
function paintedSome(line: StyledLine): boolean {
  return line.segments.some((s) => s.text.trim() !== "" && (s.fg !== undefined || s.muted));
}

/** A cheap first look before any row is cut (cutting is the costly part): the dialog shape's title and
 *  row starts, which a cut does not change, or a rule run of the same width a picker's header section
 *  above it. `openFrameTop` decides; this only spares the cut on screens that cannot pass it. */
function mayBeOpenFrame(lines: StyledLine[], texts: string[], r: number, end: number, width: number): boolean {
  const title = texts[r + 1] === "" ? r + 2 : r + 1;
  if (title <= end && /^ \S/.test(texts[title]!) && paintedSome(lines[title]!)) {
    const rows = texts.slice(title + 1, end + 1);
    if (rows.every((row) => row === "" || row.startsWith(" ") || /^[>→] /.test(row))) return true;
  }
  for (let h = r - 1; h >= 0 && r - h <= MAX_PICKER_HEADER_ROWS + 1; h--) {
    const run = /^─{8,}/.exec(texts[h]!);
    if (run === null || displayWidth(run[0]) !== width) continue;
    // A picker's header holds its painted key-hint row; only those few rows are cut to look.
    for (let row = h + 1; row < r; row++) {
      const cut = cropLine(lines[row]!, width);
      const visible = cut.segments.filter((s) => s.text.trim() !== "");
      const hint = lineText(cut).trimEnd();
      if (visible.length > 0 && visible.every((s) => s.fg !== undefined || s.muted) && (keyHintPairs(hint) >= 2 || listDialogHint(hint))) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/** The first `columns` display columns of `text`. */
function cropText(text: string, columns: number): string {
  let out = "";
  let used = 0;
  for (const cluster of clusters(text)) {
    const width = displayWidth(cluster);
    if (used + width > columns) break;
    out += cluster;
    used += width;
  }
  return out;
}

function clusters(text: string): string[] {
  const segmenter = graphemeSegmenter();
  return segmenter === null ? Array.from(text) : Array.from(segmenter.segment(text), (s) => s.segment);
}

/** One row cut at `columns` display columns, its styles kept. */
export function cropLine(line: StyledLine, columns: number): StyledLine {
  const segments: StyledLine["segments"] = [];
  let used = 0;
  for (const segment of line.segments) {
    if (used >= columns) break;
    const kept = cropText(segment.text, columns - used);
    if (kept.length > 0) segments.push(kept.length === segment.text.length ? segment : { ...segment, text: kept });
    used += displayWidth(kept);
    if (kept.length < segment.text.length) break;
  }
  return { ...line, segments };
}

/** What the pi readers read: the screen, or the screen cropped at OmO's side panel. Row indices are
 *  the screen's either way. */
export function piView(lines: StyledLine[]): PiView {
  const column = panelColumn(lines);
  if (column === null) return { lines, cropped: false, column: null };
  return { lines: lines.map((line) => cropLine(line, column)), cropped: true, column };
}

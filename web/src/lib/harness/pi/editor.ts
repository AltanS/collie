// Conservative, Pi-local analysis of the stock inline editor rendered by Pi 0.82.1.
//
// This recognises only a complete, single-row editor immediately above Pi's built-in two-row footer.
// The narrow physical-tail shape deliberately leaves wrapped/scrolled editors, extension status rows,
// autocomplete, replacement editors, and torn layouts in the raw mirror.

import { lineText, type StyledLine } from "../../blocks";

export interface PiEditor {
  /** Inclusive indexes of the two editor border rows. */
  top: number;
  bottom: number;
  /** The only safely reconstructable (single-row) draft, or null for an empty editor. */
  draft: string | null;
}

const MIN_BORDER_WIDTH = 20;
const TOKEN = String.raw`\d+(?:\.\d+)?[kM]?`;
// The stock footer constructs these fields in this order. The model name is right-aligned after at
// least two spaces, so it remains intentionally unconstrained (it is provider/user configuration).
const METER = new RegExp(
  String.raw`^(?:↑${TOKEN} )?(?:↓${TOKEN} )?(?:R${TOKEN} )?(?:W${TOKEN} )?(?:CH\d+\.\d+% )?(?:\$\d+\.\d{3}(?: \(sub\))? )?(?<context>(?:\d+\.\d+%|\?)\/${TOKEN}(?: \(auto\))?)(?: {2,}\S.*)?$`,
  "u",
);

/** A full-width stock border is exactly repeated U+2500, never a labelled/trimmed rule. */
function borderWidth(line: StyledLine): number | null {
  const text = lineText(line);
  return /^─+$/u.test(text) && text.length >= MIN_BORDER_WIDTH ? text.length : null;
}

/** Pi's footer/borders are foreground-only; backgrounds, reverse video, and emphasis are foreign. */
function foregroundOnly(segment: StyledLine["segments"][number]): boolean {
  return (
    segment.fg !== undefined &&
    segment.bg === undefined &&
    !segment.inverse &&
    !segment.bold &&
    !segment.dim &&
    !segment.italic &&
    !segment.underline &&
    !segment.strike
  );
}

/** The one foreground colour used by a stock border/cwd row, or null for a mixed/foreign style. */
function singleForeground(line: StyledLine): string | null {
  let foreground: string | undefined;
  for (const segment of line.segments) {
    if (!foregroundOnly(segment)) return null;
    if (foreground === undefined) foreground = segment.fg;
    else if (segment.fg !== foreground) return null;
  }
  return foreground ?? null;
}

function graphemeCount(text: string): number | null {
  if (typeof Intl.Segmenter !== "function") return null;
  let count = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count++;
  return count;
}

/** Pi paints exactly one SGR-7 grapheme for its cursor; an ordinary explicit background is not one. */
function cursorSegment(line: StyledLine) {
  const inverse = line.segments.filter((segment) => segment.inverse);
  return inverse.length === 1 && graphemeCount(inverse[0]!.text) === 1 ? inverse[0]! : null;
}

function isEditorFrame(lines: StyledLine[], top: number): boolean {
  const topWidth = borderWidth(lines[top]!);
  const bottomWidth = borderWidth(lines[top + 2]!);
  if (topWidth === null || topWidth !== bottomWidth) return false;
  const topForeground = singleForeground(lines[top]!);
  return topForeground !== null && topForeground === singleForeground(lines[top + 2]!) && cursorSegment(lines[top + 1]!) !== null;
}

/** Require the footer's source order and permit only its one warning/error context colour change. */
function isStockFooter(cwd: StyledLine, meter: StyledLine, width: number): boolean {
  const cwdForeground = singleForeground(cwd);
  if (cwdForeground === null || !/^(?:\/|~(?:\/|$))/.test(lineText(cwd))) return false;

  const text = lineText(meter);
  if (text.length !== width) return false;
  const match = METER.exec(text);
  if (match === null || match.groups?.context === undefined) return false;
  const contextStart = match.index + match[0].indexOf(match.groups.context);
  const contextEnd = contextStart + match.groups.context.length;

  let differentForeground: string | undefined;
  let offset = 0;
  for (const segment of meter.segments) {
    if (!foregroundOnly(segment)) return false;
    if (segment.fg !== cwdForeground) {
      if (differentForeground === undefined) differentForeground = segment.fg;
      if (segment.fg !== differentForeground || offset < contextStart || offset + segment.text.length > contextEnd) {
        return false;
      }
    }
    offset += segment.text.length;
  }
  return true;
}

/**
 * Analyse one fully visible standard editor. The footer must be the physical tail: there is no safe
 * way to distinguish a custom status/overlay tail from stock Pi bytes. A rendered grid also cannot
 * preserve trailing draft whitespace, so draft recovery intentionally uses trimEnd(); internal spaces
 * (including the grapheme beneath the cursor) remain intact.
 */
export function analysePiEditor(lines: StyledLine[]): PiEditor | null {
  if (lines.length < 5) return null;

  const footerFirst = lines.length - 2;
  const bottom = footerFirst - 1;
  const input = bottom - 1;
  const top = input - 1;
  if (top < 0 || !isEditorFrame(lines, top)) return null;

  const width = borderWidth(lines[top]!);
  if (width === null || !isStockFooter(lines[footerFirst]!, lines[footerFirst + 1]!, width)) return null;

  // A second complete-looking editor frame makes the layout ambiguous, even if only one is at tail.
  let frames = 0;
  for (let i = 0; i + 2 < lines.length; i++) if (isEditorFrame(lines, i)) frames++;
  if (frames !== 1) return null;

  const draft = lineText(lines[input]!).trimEnd();
  return { top, bottom, draft: draft.length === 0 ? null : draft };
}

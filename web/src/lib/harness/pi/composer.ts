// The pi editor frame, in the layouts Herdr reports as `pi`:
//   Stock pi 0.85.1, 0.87.1 and 1.1.0 (pi--v0851-*, pi--v0871-*, pi--v110-*): rule, the draft at column
//   zero with no glyph (a blank row padded with spaces when empty), rule, then status rows.
//   OmO 5.1.30 (pi--omo-v5130-idle.txt, -draft.txt): rule, a column-zero `❯` row with two-space
//   continuations, rule, then 1–3 styled status rows.
// While a turn runs the top rule may carry a label (`── ⠴ Working ───`, pi--v085-working-editor.txt),
// and a scrolled editor writes its overflow into a rule (`─── ↑ 2 more ───`, read from pi's editor by
// the PR 397 contributor; no capture yet). Between the bottom rule and the status rows the slash
// palette can stand while a `/` draft is typed, in two forms: stock pi's (pi--v110-slash-palette.txt),
// `→ ` on the selected entry, two spaces before the others and before its `(n/m)` counter; and OmO's
// (pi--omo-v5130-slash-model.txt), `  → ` on the selected entry and four spaces before the others. The
// `→` may stand on any one row: the list scrolls under it.
//
// pi 1.2.0 `editorPaddingX` (issue 442): the editor pads every row it draws, the draft rows and the
// palette rows alike, with that many spaces on each side (pi-tui components/editor.js). The rules and
// the status rows stay at column zero. A padded draft therefore opens with a space, as a panel's title
// does; the editor is told from a panel by its cursor cell (see `indentedEditor`).
//
// An extension may empty pi's footer (`ctx.ui.setFooter`), and then there is no status row: the bottom
// rule is the last non-blank row (issue 445).
//
// The status rows are painted (pi dims its own footer rows), except the last, which may be plain:
// pi's footer prints every extension's `ctx.ui.setStatus` text on ONE row after its own, unstyled
// unless the extension paints it (pi-coding-agent's components/footer.js). A default OmO install
// prints its badge and memory status there with no colour (pi--omo-v5130-plain-idle.txt).
//
// A question replaces the editor between the rules, so a frame is a composer only when no pi modal
// is on screen (index.ts asks ask.ts for that too); a status tail alone never permits typing.
import { MIRROR_BG, MIRROR_FG } from "../../ansi";
import { lineText, type StyledLine } from "../../blocks";

const RULE = /^─{8,}$/;
/** A rule carrying a label: a turn label (`── ⠴ Working ───`) or a scroll mark (`─── ↑ 2 more ───`). */
const LABELLED_RULE = /^─{2,} \S.*? ─{3,}$/;
const PROMPT = /^❯(?: ([\s\S]*))?$/;
const CONTINUATION = /^ {2}([\s\S]*)$/;
const BOX_EDGE = /^[─-╿]/;
const MAX_EDITOR_ROWS = 100;
const MAX_STATUS_ROWS = 4;
/** The palette is a window onto a longer list; its height is the pane's, and this bounds the scan. */
const MAX_PALETTE_ROWS = 32;
/** A picker's header sits between two rules above its list (OmO's and pi's `/tree`: a title, two
 *  hint rows, the search row, pi--omo-v5130-picker-tree.txt); this bounds that section. */
export const MAX_PICKER_HEADER_ROWS = 8;

function text(line: StyledLine): string {
  return lineText(line).trimEnd();
}

function ruleColor(line: StyledLine): string | undefined {
  return line.segments.find((segment) => segment.text.trim() !== "")?.fg;
}

function styled(line: StyledLine): boolean {
  return line.segments.some((s) => s.text.trim() !== "" && (s.fg !== undefined || s.muted));
}

/** A run of `─` shorter than the editor: text the operator pasted into the draft (the canary's
 *  `15-rule` message, scripts/harness-canary/messages.ts), never one of the editor's own rules. */
function pastedRule(value: string, width: number): boolean {
  return /^─+$/.test(value) && value.length < width;
}

function isRule(value: string): boolean {
  return RULE.test(value) || LABELLED_RULE.test(value);
}

/** A status row's shape: not blank, not a box edge, not a prompt row, not the palette. */
function statusRow(line: StyledLine): boolean {
  const value = text(line);
  return value !== "" && !BOX_EDGE.test(value.trimStart()) && !PROMPT.test(value) && !value.startsWith(" ") &&
    !value.startsWith("→ ");
}

/**
 * pi's status rows are painted, every one, except that the LAST may be plain when a painted row
 * stands above it: that row is the one extension-status line pi's footer prints (see the header).
 * Blank rows are skipped. So a plain row straight under a rule, or two plain rows, is output, not pi.
 */
export function paintedStatus(rows: StyledLine[]): boolean {
  const filled = rows.filter((row) => text(row) !== "");
  if (filled.length === 0) return false;
  return filled.every((row, index) => styled(row) || (index > 0 && index === filled.length - 1));
}

/** The palette rows in either form (see the header), unpadded: exactly one entry carries the `→`, and
 *  every other row is an entry of the same form or the stock counter. */
function plainPaletteRows(rows: string[]): boolean {
  const stock = rows.filter((row) => row.startsWith("→ ")).length;
  const omo = rows.filter((row) => row.startsWith("  → ")).length;
  if (stock + omo !== 1) return false;
  const other = stock === 1 ? /^ {2}(?!→ )\S/ : /^ {4}\S/;
  return rows.every((row) => row.startsWith("→ ") || row.startsWith("  → ") || /^ {2}\(\d+\/\d+\)$/.test(row) || other.test(row));
}

/** The palette rows as pi draws them: the editor's `editorPaddingX` spaces stand before every row, so
 *  the arrow row's own indent is the padding (or, for OmO's form, two less). Padding zero is the
 *  captured case. */
function paletteRows(rows: string[]): boolean {
  const arrow = rows.find((row) => /^ *→ /.test(row));
  if (arrow === undefined) return false;
  const indent = arrow.length - arrow.trimStart().length;
  return [indent, indent - 2].some((pad) => {
    if (pad < 0) return false;
    const margin = " ".repeat(pad);
    return rows.every((row) => row.startsWith(margin)) && plainPaletteRows(rows.map((row) => row.slice(pad)));
  });
}

/**
 * The nearest row above `from`, at most `limit` rows up, that is a rule of `width` characters, bare
 * or labelled: the top of the section whose bottom rule is `from`. -1 when there is none.
 */
export function ruleAbove(texts: string[], from: number, width: number, limit: number): number {
  for (let r = from - 1; r >= 0 && from - r <= limit; r--) {
    if (texts[r]!.length === width && isRule(texts[r]!)) return r;
  }
  return -1;
}

export interface PiTail {
  /** The editor's bottom rule. */
  bottom: number;
  /** First status row (after the palette when one is open). */
  statusStart: number;
  /** Exclusive end of the status rows; only blank padding follows. */
  end: number;
  palette: boolean;
}

/** The editor's bottom rule, the optional palette under it and the status rows at the tail. */
export function tailRule(lines: StyledLine[]): PiTail | null {
  let end = lines.length;
  while (end > 0 && text(lines[end - 1]!) === "") end--;
  // No status row at all (issue 445): an extension replaced pi's footer with an empty one, so the
  // editor's bottom rule is the last thing on screen. A rule of the same width must stand above it, and `locateComposer`
  // still demands the same colour and a clean editor body, which is what keeps other boxes out.
  if (end > 0 && RULE.test(text(lines[end - 1]!)) &&
    ruleAbove(lines.map(text), end - 1, text(lines[end - 1]!).length, MAX_EDITOR_ROWS) >= 0) {
    return { bottom: end - 1, statusStart: end, end, palette: false };
  }
  // The status rows: one to four, painted as `paintedStatus` says.
  let statusStart = end;
  while (statusStart > 0 && end - statusStart < MAX_STATUS_ROWS && statusRow(lines[statusStart - 1]!)) statusStart--;
  if (statusStart === end || statusStart === 0 || !paintedStatus(lines.slice(statusStart, end))) return null;
  if (RULE.test(text(lines[statusStart - 1]!))) return { bottom: statusStart - 1, statusStart, end, palette: false };
  // The palette, directly under the bottom rule, in either form.
  let top = statusStart;
  while (top > 0 && statusStart - top < MAX_PALETTE_ROWS && /^(?: *→ | +\S)/.test(text(lines[top - 1]!))) top--;
  if (top === statusStart || top < 1 || !RULE.test(text(lines[top - 1]!))) return null;
  if (!paletteRows(lines.slice(top, statusStart).map(text))) return null;
  return { bottom: top - 1, statusStart, end, palette: true };
}

export interface PiComposer {
  readonly layout: "omo" | "stock";
  readonly top: number;
  readonly bottom: number;
  readonly statusStart: number;
  readonly end: number;
}

/** The editor draws its cursor as an inverse-video cell (`\x1b[7m`) on every render, empty or not. */
function cursorCell(line: StyledLine): boolean {
  return line.segments.some((s) => s.text !== "" && s.fg === MIRROR_BG && s.bg === MIRROR_FG);
}

/**
 * Rows whose first row opens with a space are the stock editor padded by pi's `editorPaddingX`
 * (issue 442) only when both hold, and a panel title (` Which package manager?`) fails each:
 *   - the editor's cursor cell stands in one of the rows: a panel draws none. The cell is pi's own
 *     (`\x1b[7m`), so a pane that cannot show reverse video never reads as an editor, and padding
 *     fails closed to the old refusal;
 *   - every non-blank row opens with at least one space. pi pads every row it draws, so a select
 *     dialog's pointer row (`> 1. Red`) or a picker's search row at column zero is never part of it.
 */
function indentedEditor(rows: StyledLine[], filled: StyledLine[]): boolean {
  return rows.some(cursorCell) && filled.every((row) => text(row).startsWith(" "));
}

export function locateComposer(lines: StyledLine[]): PiComposer | null {
  const tail = tailRule(lines);
  if (tail === null) return null;
  const { bottom } = tail;
  const bottomLine = lines[bottom]!;
  const width = text(bottomLine).length;
  // The top rule is the nearest rule of the bottom rule's width. A shorter run of `─` is text the
  // operator pasted into the draft (the canary's `15-rule` message), never the editor's own border.
  let top = bottom - 1;
  while (top >= 0) {
    const value = text(lines[top]!);
    if (isRule(value) && value.length === width) break;
    if (bottom - top > MAX_EDITOR_ROWS) return null;
    top--;
  }
  if (top < 0 || top + 1 === bottom) return null;
  const topLine = lines[top]!;
  if (ruleColor(topLine) !== ruleColor(bottomLine)) return null;
  const rows = lines.slice(top + 1, bottom);
  if (rows.some((row) => isRule(text(row)) && text(row).length === width)) return null;
  const first = rows[0]!;
  let layout: "omo" | "stock";
  if (PROMPT.test(text(first))) {
    // OmO: the prompt glyph wears the rules' colour, and every later row is a two-space continuation.
    if (ruleColor(bottomLine) === undefined || ruleColor(first) !== ruleColor(bottomLine)) return null;
    const ok = rows.slice(1).every((row) => {
      const value = text(row);
      return value === "" || (CONTINUATION.test(value) && (!BOX_EDGE.test(value.trimStart()) || pastedRule(value.trimStart(), width)));
    });
    if (!ok) return null;
    layout = "omo";
  } else {
    // Stock pi: the draft starts at column zero, or at the editor's padding. Its first row is the
    // operator's text, so a first row opening with a space is a panel drawn between the rules (every
    // question dialog in the corpus opens with a one-space title or question row, and so does OmO's)
    // unless the rows are an editor padded by `editorPaddingX` (`indentedEditor`). Later rows may be
    // indented: a pasted code block (the canary's `07-indented` message). A box glyph is a panel on
    // any row, unless it is a shorter pasted rule.
    const filled = rows.filter((row) => text(row) !== "");
    const firstText = rows.findIndex((row) => text(row) !== "");
    if (firstText >= 0 && text(rows[firstText]!).startsWith(" ") && !indentedEditor(rows, filled)) return null;
    const ok = rows.every((row) => {
      const value = text(row);
      if (value === "") return true;
      const glyph = value.trimStart();
      return (!BOX_EDGE.test(glyph) || pastedRule(glyph, width)) && !PROMPT.test(glyph);
    });
    if (!ok) return null;
    layout = "stock";
  }
  // The palette opens only over a slash command.
  if (tail.palette && !draftOf(lines, { layout, top, bottom, statusStart: tail.statusStart, end: tail.end })?.startsWith("/")) {
    return null;
  }
  return { layout, top, bottom, statusStart: tail.statusStart, end: tail.end };
}

function draftOf(lines: StyledLine[], composer: PiComposer): string | null {
  const draft = lines.slice(composer.top + 1, composer.bottom)
    .map((line, index) => {
      const value = text(line);
      if (composer.layout === "stock") return value;
      return index === 0 ? (PROMPT.exec(value)?.[1] ?? "") : value.slice(2);
    })
    // One space per row seam, and nothing for a blank row or an indent: the read-back
    // (`draftCarriesSend`, lib/reply-action.ts) lets exactly one space stand for any whitespace
    // the send carried there (`\n\n`, `\n    `), and takes every other gap literally.
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .join(" ");
  return draft || null;
}

export function composerDraft(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  return composer === null ? null : draftOf(lines, composer);
}

/** The bridge binds a region only when it ends within this many non-blank rows of the tail. */
const BRIDGE_PROMPT_TAIL_LINES = 6;

/** Bind clearing to the exact editor frame, not changing status counters below it. Null (an unbound
 *  write) when an open palette pushes the frame out of the bridge's tail window. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const composer = locateComposer(lines);
  if (composer === null) return null;
  if (composer.end - composer.bottom - 1 > BRIDGE_PROMPT_TAIL_LINES - 1) return null;
  return lines.slice(composer.top, composer.bottom + 1).map(text).join("\n");
}

/** The status rows under the bottom rule. They stay readable while a question replaces the editor
 *  (the rule above them is then the dialog's bottom rule, pi--omo-v5130-single-described.txt). */
export function composerStatusLines(lines: StyledLine[]): StyledLine[] {
  const tail = tailRule(lines);
  return tail === null ? [] : lines.slice(tail.statusStart, tail.end);
}

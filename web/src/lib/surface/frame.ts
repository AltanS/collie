// The input frame: where a harness's input box sits on a screen read, found from one profile's
// `idle` anchors (M56 spec 03, experiments/reader-stability/ARCHITECTURE.md). One module, three
// callers: the phone's chrome reader, the bridge's session-name read and the bridge's tap binding.
// Before it, each of them searched for the box in its own way.
//
// What it finds, and nothing more: the top edge, the interior rows (the prompt row and the wrapped
// draft under it), the bottom edge, whether the interior is a placeholder, and the volatile rows a
// fold must ignore. It does not judge whether a dialog is up. A frame on a screen says "an input box
// is drawn here", never "the keyboard is free"; the modal cues and the Surface fold (spec 04) decide
// that, and the phone's chrome reader keeps its own modal checks until then.
//
// Pure: no DOM, no Bun API, no harness name and no harness constant. Every glyph, pattern and bound
// comes from the profile. The same rows always give the same frame, and the screen width is read
// from nothing but the rows.

import { displayWidth } from "../text-width";
import { listedBottom, ownListUnder } from "./command-list";
import { readAboveNotice } from "./notice";
import type { FrameAnchor, Profile } from "./profile";

/** The profile block this module reads. */
export type IdleProfile = Profile["idle"];

/** One styled run of a row. The attribute flags are the SGR ones the placeholder test can name. */
export interface FrameRun {
  readonly text: string;
  /** The run's foreground colour; absent for the terminal's default ink (`idle.frame.underPainted`). */
  readonly fg?: string | undefined;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
}

/** One screen row as styled runs. A parsed `StyledLine` is one. */
export interface FrameRow {
  readonly segments: readonly FrameRun[];
}

/** Rows `first` to `last`, both included. */
export interface RowSpan {
  readonly first: number;
  readonly last: number;
}

/** Which profile anchor matched. `top`, `prompt` and `bottom` are on every frame. */
export type FrameAnchorHit = "top" | "label" | "prompt" | "draft" | "bottom" | "placeholder-text" | "placeholder-sgr";

export interface Frame {
  /** The row of the top edge. */
  readonly top: number;
  /** The row of the bottom edge. */
  readonly bottom: number;
  /** The words the top edge carries (the anchor's `label` group), or null on a bare edge. */
  readonly label: string | null;
  readonly interior: {
    /** The first row inside the edges (`top + 1`). */
    readonly first: number;
    /** The prompt row: where the draft hole starts. Rows between `first` and it are blank padding. */
    readonly prompt: number;
    /** The last row inside the edges (`bottom - 1`). */
    readonly last: number;
    /** The draft as one line: the hole on the prompt row, then each non-blank wrapped row, trimmed
     *  and joined with one space. Empty for an empty box. Holds the placeholder text when
     *  `placeholder` is true. */
    readonly text: string;
  };
  /** True when the interior shows the profile's placeholder: one of its texts, or nothing but runs
   *  in the placeholder's SGR attribute. An empty interior is not a placeholder. */
  readonly placeholder: boolean;
  /** Rows a fold must ignore when it compares two reads. `above` is the band over the top edge;
   *  `status` and `footer` are the run under the bottom edge, when the rows there walk as one.
   *  `named` lists the rows of the profile's named footer run (`idle.volatile.below.footerRows`) on a
   *  walk that holds, and nothing on one that fails: no modal cue reads these rows. */
  readonly volatile: {
    readonly above: RowSpan | null;
    readonly status: RowSpan | null;
    readonly footer: RowSpan | null;
    readonly named: readonly NamedRow[];
  };
  readonly anchorsHit: readonly FrameAnchorHit[];
}

/** A row under the bottom edge that a named footer row of the profile matches. */
export interface NamedRow {
  readonly row: number;
  /** The profile's name for the row. */
  readonly name: string;
}

/** One anchor, compiled: its pattern, the cells it must span, its column, and whether it is a blank row. */
interface CompiledAnchor {
  readonly pattern: RegExp;
  readonly cells: number;
  readonly column: number;
  readonly maxColumn: number;
  readonly blank: boolean;
  /** The bottom anchor of an open box: the last non-blank row of the screen. */
  readonly open: boolean;
}

/** The interior walk's own patterns (`idle.frame.walk`), compiled. */
interface CompiledInterior {
  readonly rows: RegExp | null;
  readonly trailerRow: RegExp | null;
  readonly trailerPad: RegExp | null;
  readonly maxPad: number;
  readonly continuation: RegExp | null;
  readonly under: RegExp | null;
  readonly underPainted: boolean;
}

interface CompiledFooterRow {
  readonly name: string;
  readonly pattern: RegExp;
}

interface Compiled {
  readonly top: CompiledAnchor;
  readonly prompt: CompiledAnchor;
  readonly bottom: CompiledAnchor;
  readonly footerRows: readonly CompiledFooterRow[];
  readonly interior: CompiledInterior;
  /** The ghost text's colours (`idle.inlineHint`); null for a profile that names none. */
  readonly hint: ReadonlySet<string> | null;
}

const compiledByIdle = new WeakMap<IdleProfile, Compiled>();

function compileAnchor(anchor: FrameAnchor, flags: string): CompiledAnchor {
  return {
    pattern: new RegExp(anchor.pattern, flags),
    cells: anchor.minCells ?? 0,
    column: anchor.column,
    maxColumn: anchor.maxColumn ?? anchor.column,
    blank: anchor.blank === true,
    open: anchor.open === true,
  };
}

function compile(idle: IdleProfile): Compiled {
  const known = compiledByIdle.get(idle);
  if (known !== undefined) return known;
  const { top, prompt, bottom, rows, trailer, continuation, under } = idle.frame;
  const compiled: Compiled = {
    top: compileAnchor(top, "u"),
    // `d` gives the draft hole's offset, so the placeholder test reads only the runs inside it.
    prompt: compileAnchor(prompt, "du"),
    bottom: compileAnchor(bottom, "u"),
    footerRows: (idle.volatile.below.footerRows ?? []).map((row) => ({ name: row.name, pattern: new RegExp(row.pattern, "u") })),
    interior: {
      rows: rows === undefined ? null : new RegExp(rows, "u"),
      trailerRow: trailer === undefined ? null : new RegExp(trailer.row, "u"),
      trailerPad: trailer?.pad === undefined ? null : new RegExp(trailer.pad, "u"),
      maxPad: trailer?.maxPad ?? 0,
      // `d` gives the text group's offset, so the ghost text test reads the runs under it.
      continuation: continuation === undefined ? null : new RegExp(continuation, "du"),
      under: under === undefined ? null : new RegExp(under, "u"),
      underPainted: idle.frame.underPainted === true,
    },
    hint: idle.inlineHint === undefined ? null : new Set(idle.inlineHint.fg),
  };
  compiledByIdle.set(idle, compiled);
  return compiled;
}

/** Whether the profile draws its box with a blank top edge. Such a box gets the strict interior (see frameAt). */
function blankTop(idle: IdleProfile): boolean {
  return idle.frame.top.blank === true;
}

/** The plain text of a row. */
export function rowText(row: FrameRow): string {
  let text = "";
  for (const run of row.segments) text += run.text;
  return text;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Unstyled rows for a caller that holds only text. */
export function plainRows(texts: readonly string[]): FrameRow[] {
  return texts.map((text) => ({ segments: [{ text }] }));
}

/** The column a row's text starts in: its count of leading spaces. A blank row has none. */
function textColumn(text: string): number {
  return text.length - text.trimStart().length;
}

/** Whether an anchor matches a row. A blank anchor matches a blank row. Any other anchor needs the
 *  row's text to start in the anchor's column, the pattern to match the row with its trailing space
 *  cut, and the row to span at least `minCells`. */
function anchored(text: string, anchor: CompiledAnchor): RegExpExecArray | null {
  if (isBlank(text)) return anchor.blank ? anchor.pattern.exec("") : null;
  const column = textColumn(text);
  if (anchor.blank || column < anchor.column || column > anchor.maxColumn) return null;
  const trimmed = text.trimEnd();
  if (anchor.cells > 0 && displayWidth(trimmed) < anchor.cells) return null;
  return anchor.pattern.exec(trimmed);
}

/** The edge a row is, as the frame walk sees it: one of the three anchors. A row that matches the
 *  bottom anchor also matches the top one on a bare edge; the walk only needs to know it is an edge.
 *  A blank row is never an edge here, so a blank row inside a draft is crossed like any other. */
export function frameEdge(text: string, idle: IdleProfile): "prompt" | "bottom" | "top" | null {
  if (isBlank(text)) return null;
  const c = compile(idle);
  if (anchored(text, c.prompt) !== null) return "prompt";
  if (!c.bottom.open && anchored(text, c.bottom) !== null) return "bottom";
  if (anchored(text, c.top) !== null) return "top";
  return null;
}

/**
 * Whether a row may stand inside a box whose edges are blank rows: a blank row, or a row indented at
 * least `continuationIndent` columns (a wrapped or later line of the draft). Text further left is the
 * transcript or a dialog, so the walk must stop there.
 */
export function interiorRow(text: string, idle: IdleProfile): boolean {
  return isBlank(text) || textColumn(text) >= idle.frame.continuationIndent;
}

/** Whether a row's first visible run is painted: a foreground colour, or dim. A cell that shows no
 *  glyph (a reverse-video cursor) is not visible here, whatever its colours. */
function paintedRow(row: FrameRow): boolean {
  const run = row.segments.find((segment) => segment.text.trim() !== "");
  return run !== undefined && (run.fg !== undefined || run.dim === true);
}

/**
 * Whether the rows under the bottom edge are a status line an extension draws in the harness's place
 * (`idle.frame.underPainted`): a painted row straight under the edge, and from it to the screen's last
 * row one run with no blank row, at most `volatile.below.maxRows` tall. That is where a footer sits.
 * The harness paints its other rows too (a dialog's title, a picker's list, the transcript), so a
 * painted row alone is no footer: under a rule pair that is not the box (a picker taller than the
 * pane, a read cut inside the screen) those rows stand apart by a blank row or run on past the bound.
 */
function paintedFooter(rows: readonly FrameRow[], texts: readonly string[], bottom: number, idle: IdleProfile): boolean {
  const first = bottom + 1;
  let end = texts.length;
  while (end > first && isBlank(texts[end - 1]!)) end--;
  if (end <= first || end - first > idle.volatile.below.maxRows || !paintedRow(rows[first]!)) return false;
  for (let j = first; j < end; j++) if (isBlank(texts[j]!)) return false;
  return true;
}

/** The placeholder attribute as a run flag, or null when the profile names one this module cannot
 *  read (then only the texts can mark a placeholder). */
function sgrFlag(sgr: number): keyof Omit<FrameRun, "text"> | null {
  switch (sgr) {
    case 1:
      return "bold";
    case 2:
      return "dim";
    case 3:
      return "italic";
    case 4:
      return "underline";
    case 9:
      return "strike";
    default:
      return null;
  }
}

/**
 * Whether every visible character in the draft hole is drawn in the placeholder attribute. The prompt
 * row is read from the hole's offset, so the marker in front of it never counts; the rows under it
 * are read whole. False when the hole holds nothing visible.
 */
function holeIsFaint(rows: readonly FrameRow[], prompt: number, holeStart: number, last: number, sgr: number): boolean {
  const flag = sgrFlag(sgr);
  if (flag === null) return false;
  let sawContent = false;
  for (let j = prompt; j <= last; j++) {
    let offset = 0;
    for (const run of rows[j]!.segments) {
      const from = j === prompt ? Math.max(0, holeStart - offset) : 0;
      offset += run.text.length;
      const visible = run.text.slice(from);
      if (visible.trim().length === 0) continue;
      if (run[flag] !== true) return false;
      sawContent = true;
    }
  }
  return sawContent;
}

/** Whether a draft text is one of the profile's placeholder texts, or starts with one of its prefixes. */
function isPlaceholderText(text: string, idle: IdleProfile): boolean {
  if (text.length === 0) return false;
  if (idle.placeholders.texts.includes(text)) return true;
  return (idle.placeholders.prefixes ?? []).some((prefix) => text.startsWith(prefix));
}

/** One piece of the draft: its row, and its first and past-last offset in the row's text. */
interface DraftPiece {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

/** The piece of `text` from `from` to `to`, trimmed at both ends, or null when it holds nothing visible. */
function trimmedPiece(row: number, text: string, from: number, to: number): DraftPiece | null {
  const slice = text.slice(from, to);
  const trimmed = slice.trim();
  if (trimmed.length === 0) return null;
  const start = from + (slice.length - slice.trimStart().length);
  return { row, start, end: start + trimmed.length };
}

/** The run attributes that make a style, beside the foreground colour. */
const RUN_FLAGS = ["bold", "dim", "italic", "underline", "strike"] as const;

const LETTERS = /^\p{L}+$/u;

/**
 * Where the profile's ghost text starts in the draft's last piece (`idle.inlineHint`), or null when the
 * piece ends in none. The run under the piece's last character is the ghost only when all of these
 * hold: its foreground is one of the profile's colours, it carries no other attribute, its part inside
 * the piece is letters only and nothing visible follows in the run, and it opens straight after a
 * visible character of the piece in another style. A harness paints its word completion so, after the
 * cursor at the end of the draft; a run that fails any test is read as typed text.
 */
function hintStart(row: FrameRow, piece: DraftPiece, colours: ReadonlySet<string>): number | null {
  let from = 0;
  let previous: FrameRun | null = null;
  for (const run of row.segments) {
    const to = from + run.text.length;
    if (to < piece.end) {
      if (run.text.length > 0) previous = run;
      from = to;
      continue;
    }
    const before = previous;
    if (from <= piece.start || before === null) return null;
    if (run.fg === undefined || !colours.has(run.fg) || RUN_FLAGS.some((flag) => run[flag] === true)) return null;
    if (!LETTERS.test(run.text.slice(0, piece.end - from)) || run.text.slice(piece.end - from).trim().length > 0) return null;
    if (!/\S$/u.test(before.text)) return null;
    const sameStyle = before.fg === run.fg && RUN_FLAGS.every((flag) => (before[flag] === true) === (run[flag] === true));
    return sameStyle ? null : from;
  }
  return null;
}

/**
 * The draft as one line: each piece's text joined with one space, with the profile's ghost text cut off
 * the end of the last piece ({@link hintStart}).
 */
function draftText(rows: readonly FrameRow[], texts: readonly string[], pieces: readonly DraftPiece[], hint: ReadonlySet<string> | null): string {
  const last = pieces[pieces.length - 1];
  const ghost = last === undefined || hint === null ? null : hintStart(rows[last.row]!, last, hint);
  return pieces
    .map((piece) => texts[piece.row]!.slice(piece.start, piece === last && ghost !== null ? ghost : piece.end).trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .trim();
}

/** The statusline run and the footer under the bottom edge (`Frame.volatile`). */
interface BelowRun {
  readonly status: RowSpan | null;
  readonly footer: RowSpan | null;
}

/** The index of the first named footer row at or after `from` that matches the row, or -1. */
function footerRowIndex(text: string, rows: readonly CompiledFooterRow[], from: number): number {
  if (isBlank(text)) return -1;
  const trimmed = text.trimEnd();
  for (let k = from; k < rows.length; k++) if (rows[k]!.pattern.test(trimmed)) return k;
  return -1;
}

/** The statusline run, the footer, and the named rows under the bottom edge (`Frame.volatile`). */
interface NamedBelowRun extends BelowRun {
  readonly named: readonly NamedRow[];
}

/**
 * The run under the bottom edge with the profile's named footer rows (`idle.volatile.below.footerRows`).
 *
 * The named run sits at the bottom. It starts on a row the FIRST entry of the list matches, set
 * apart by a blank row over it, and every row after it matches a later entry in the list's order
 * (the first entry only once); blank rows may stand between. It is at most `footerMaxRows` tall.
 * Anything else is no named run, and the rows walk as before ({@link walkBelow}) with nothing named.
 *
 * Over an accepted run the rows walk as a statusline with NO footer of their own, so a popup or a
 * dialog between the statusline and the run fails the walk instead of passing as a second footer.
 * A failed walk names nothing: every row stays in the cues' sight. On a good walk `named` holds the
 * run's rows, and the last statusline row when an entry matches it (a hint on the mode row).
 */
function walkBelowNamed(texts: readonly string[], bottom: number, end: number, idle: IdleProfile, rows: readonly CompiledFooterRow[]): NamedBelowRun {
  const below = idle.volatile.below;
  const plain = (): NamedBelowRun => ({ ...walkBelow(texts, bottom, end, below), named: [] });
  if (rows.length === 0) return plain();

  // Up from the last row over blank rows and rows a later entry matches, to the first entry's row.
  let first = end - 1;
  while (first > bottom && (isBlank(texts[first]!) || footerRowIndex(texts[first]!, rows, 1) >= 0)) first--;
  if (first <= bottom + 1 || footerRowIndex(texts[first]!, rows, 0) !== 0 || !isBlank(texts[first - 1]!)) return plain();
  if (end - first > below.footerMaxRows) return plain();

  // Down the run: each row matches an entry at or after the last one, never the first entry again.
  const named: NamedRow[] = [{ row: first, name: rows[0]!.name }];
  let at = 1;
  for (let j = first + 1; j < end; j++) {
    if (isBlank(texts[j]!)) continue;
    const k = footerRowIndex(texts[j]!, rows, at);
    if (k < 0) return plain();
    named.push({ row: j, name: rows[k]!.name });
    at = k;
  }

  let rest = first;
  while (rest > bottom + 1 && isBlank(texts[rest - 1]!)) rest--;
  const run = walkBelow(texts, bottom, rest, { ...below, footerMaxRows: 0 });
  if (run.status === null && rest > bottom + 1) return { status: null, footer: null, named: [] };
  if (run.status !== null) {
    const k = footerRowIndex(texts[run.status.last]!, rows, 1);
    if (k >= 0) named.unshift({ row: run.status.last, name: rows[k]!.name });
  }
  return { status: run.status, footer: { first, last: end - 1 }, named };
}

/**
 * The run under the bottom edge, walked bottom-up from the last non-blank row: an optional footer of
 * at most `footerMaxRows` rows divided off by a blank run, then at most `maxRows` status rows that
 * must reach the bottom edge. Null spans when the rows there do not walk that way (a popup, a
 * dialog, something taller); both null as well when there are no rows at all.
 */
function walkBelow(
  texts: readonly string[],
  bottom: number,
  end: number,
  below: IdleProfile["volatile"]["below"],
): BelowRun {
  let i = end - 1;
  let footer: RowSpan | null = null;

  let j = i;
  let footerRows = 0;
  while (j > bottom && !isBlank(texts[j]!) && footerRows < below.footerMaxRows) {
    footerRows++;
    j--;
  }
  if (footerRows > 0 && j > bottom && isBlank(texts[j]!)) {
    footer = { first: j + 1, last: end - 1 };
    while (j > bottom && isBlank(texts[j]!)) j--;
    i = j;
  }

  const statusLast = i;
  let statusRows = 0;
  while (i > bottom && !isBlank(texts[i]!) && statusRows < below.maxRows) {
    statusRows++;
    i--;
  }
  if (i !== bottom) return { status: null, footer: null };
  return { status: statusRows > 0 ? { first: bottom + 1, last: statusLast } : null, footer };
}

/**
 * The frame whose bottom edge is row `bottom`, or null when that row is no bottom edge or the frame
 * does not close above it.
 *
 * The walk up: rows that are no edge (and rows that are indented, whatever they look like) are the
 * wrapped draft. The first edge row must be the prompt row, then blank padding, then the top edge.
 * Every row crossed, blank or not, counts against `maxDraftRows`, so a stray edge-shaped row far up
 * the transcript cannot close a frame.
 */
export function frameAt(rows: readonly FrameRow[], bottom: number, idle: IdleProfile): Frame | null {
  const c = compile(idle);
  const texts = rows.map(rowText);
  if (idle.frame.walk === "interior") return interiorFrameAt(rows, bottom, idle);
  const bottomText = texts[bottom];
  if (bottomText === undefined || anchored(bottomText, c.bottom) === null) return null;

  const strict = blankTop(idle);
  const budget = idle.frame.maxDraftRows;
  let crossed = 0;
  let i = bottom - 1;
  let blankRun = 0;
  while (i >= 0 && frameEdge(texts[i]!, idle) === null && crossed < budget) {
    // A box with blank edges has no edge glyph to stop at: a row with text left of the indent ends
    // it, and so do two blank rows in a row (a blank edge is one row, so a second one is outside).
    if (strict && !interiorRow(texts[i]!, idle)) return null;
    blankRun = isBlank(texts[i]!) ? blankRun + 1 : 0;
    if (strict && blankRun > 1) return null;
    crossed++;
    i--;
  }
  if (i < 0) return null;
  const promptMatch = anchored(texts[i]!, c.prompt);
  if (promptMatch === null) return null;
  const prompt = i;
  i--;
  let top: number;
  let topMatch: RegExpExecArray | null;
  if (c.top.blank) {
    // A blank top edge is the row straight over the prompt row: there is no padding to pass.
    if (i < 0) return null;
    topMatch = anchored(texts[i]!, c.top);
    top = i;
  } else {
    while (i >= 0 && isBlank(texts[i]!) && crossed < budget) {
      crossed++;
      i--;
    }
    if (i < 0) return null;
    topMatch = anchored(texts[i]!, c.top);
    top = i;
  }
  if (topMatch === null) return null;

  const anchorsHit: FrameAnchorHit[] = ["top"];
  const label = topMatch.groups?.label?.trim() ?? "";
  if (label.length > 0) anchorsHit.push("label");
  anchorsHit.push("prompt");

  const hole = promptMatch.groups?.draft;
  const holeStart = promptMatch.indices?.groups?.draft?.[0] ?? texts[prompt]!.length;
  if (hole !== undefined) anchorsHit.push("draft");
  const pieces: DraftPiece[] = [];
  const holePiece = trimmedPiece(prompt, texts[prompt]!, holeStart, holeStart + (hole ?? "").length);
  if (holePiece !== null) pieces.push(holePiece);
  for (let j = prompt + 1; j < bottom; j++) {
    const piece = trimmedPiece(j, texts[j]!, 0, texts[j]!.length);
    if (piece !== null) pieces.push(piece);
  }
  const text = draftText(rows, texts, pieces, c.hint);
  anchorsHit.push("bottom");

  const byText = isPlaceholderText(text, idle);
  const bySgr = holeIsFaint(rows, prompt, holeStart, bottom - 1, idle.placeholders.sgr);
  if (byText) anchorsHit.push("placeholder-text");
  if (bySgr) anchorsHit.push("placeholder-sgr");

  let end = texts.length;
  while (end > bottom + 1 && isBlank(texts[end - 1]!)) end--;
  const { status, footer, named } = walkBelowNamed(texts, bottom, end, idle, c.footerRows);
  const above = bandAbove(texts, top, idle);

  return {
    top,
    bottom,
    label: label.length > 0 ? label : null,
    interior: { first: top + 1, prompt, last: bottom - 1, text },
    placeholder: byText || bySgr,
    volatile: { above, status, footer, named },
    anchorsHit,
  };
}

/**
 * The volatile band above a box whose top edge is `top`: up to `volatile.above.maxRows` rows, counted up
 * from the first row of a notice the profile names over the box (`idle.notices`) when one stands there,
 * so the notice's own rows never fill the band and a dialog drawn above it is still read.
 */
function bandAbove(texts: readonly string[], top: number, idle: IdleProfile): { first: number; last: number } | null {
  const notice = readAboveNotice(texts, top, idle.notices ?? [], idle.noticeGaps ?? []);
  const from = notice === null ? top : notice.first;
  const aboveRows = Math.min(idle.volatile.above.maxRows, from);
  return aboveRows > 0 ? { first: from - aboveRows, last: top - 1 } : null;
}

/** The piece a row adds to the draft on the interior walk: the profile's `text` group, or the trimmed row. */
function interiorPiece(row: number, text: string, continuation: RegExp | null): DraftPiece | null {
  if (continuation === null) return trimmedPiece(row, text, 0, text.length);
  const hit = continuation.exec(text.trimEnd());
  const span = hit?.indices?.groups?.text;
  return span === undefined ? null : trimmedPiece(row, text, span[0], span[1]);
}

/**
 * The frame of the interior walk (`idle.frame.walk`): `bottom` is the bottom edge, or the last row of
 * an open box. Up from there: the trailer rows the box always draws under the draft, then the draft,
 * to the top edge. The prompt row is the first row under the top edge that matches the prompt anchor;
 * a blank row may match, so a box with no prompt glyph has one. Null when any step fails.
 */
function interiorFrameAt(rows: readonly FrameRow[], bottom: number, idle: IdleProfile): Frame | null {
  const c = compile(idle);
  const texts = rows.map(rowText);
  const bottomText = texts[bottom];
  if (bottomText === undefined) return null;
  const open = c.bottom.open;
  if (!open && anchored(bottomText, c.bottom) === null) return null;
  // Set when the row under the box is not the harness's own: the box then stands only over the typed
  // command's own list (`idle.volatile.below.commandList`), checked once the box's text is read.
  let listed = false;
  if (c.interior.under !== null && !open) {
    // The row the harness always draws under its box: the first row there that is not blank. Where
    // the profile says so (`underPainted`), an extension's own status line passes too (paintedFooter).
    const at = texts.findIndex((text, i) => i > bottom && !isBlank(text));
    if (at >= 0 && !c.interior.under.test(texts[at]!.trimEnd()) && !(c.interior.underPainted && paintedFooter(rows, texts, bottom, idle))) {
      if (idle.volatile.below.commandList === undefined) return null;
      listed = true;
    }
  }
  const budget = idle.frame.maxDraftRows;

  // The last row of the box's interior: the bottom edge itself on an open box.
  let last = open ? bottom : bottom - 1;
  if (c.interior.trailerRow !== null) {
    let pads = 0;
    while (last >= 0 && c.interior.trailerPad !== null && pads < c.interior.maxPad && c.interior.trailerPad.test(texts[last]!.trimEnd())) {
      pads++;
      last--;
    }
    if (last < 0 || !c.interior.trailerRow.test(texts[last]!.trimEnd())) return null;
    last--;
  }

  let top = last;
  if (c.interior.rows !== null) {
    let stop = -1;
    while (top >= 0 && bottom - top <= budget && c.interior.rows.test(texts[top]!.trimEnd())) {
      // A row that is the top edge and cannot be a prompt row ends the box: a draft's indented rows
      // above it are the transcript's.
      if (anchored(texts[top]!, c.top) !== null && (isBlank(texts[top]!) ? !c.prompt.pattern.test("") : anchored(texts[top]!, c.prompt) === null)) {
        stop = top;
        break;
      }
      top--;
    }
    if (stop >= 0) top = stop;
    else top++;
    if (top > last || bottom - top > budget) return null;
  } else {
    while (top >= 0 && bottom - top <= budget && anchored(texts[top]!, c.top) === null) top--;
    if (top < 0 || bottom - top > budget) return null;
  }
  const topMatch = anchored(texts[top]!, c.top);
  if (topMatch === null) return null;

  let prompt = -1;
  let promptMatch: RegExpExecArray | null = null;
  for (let j = top + 1; j <= last; j++) {
    const row = texts[j]!;
    promptMatch = isBlank(row) ? c.prompt.pattern.exec("") : anchored(row, c.prompt);
    if (promptMatch !== null) {
      prompt = j;
      break;
    }
  }
  if (prompt < 0 || promptMatch === null) return null;

  const hole = promptMatch.groups?.draft;
  const holeStart = promptMatch.indices?.groups?.draft?.[0] ?? texts[prompt]!.length;
  const pieces: DraftPiece[] = [];
  for (let j = top + 1; j <= last; j++) {
    const piece = j === prompt ? trimmedPiece(j, texts[j]!, holeStart, holeStart + (hole ?? "").length) : interiorPiece(j, texts[j]!, c.interior.continuation);
    if (piece !== null) pieces.push(piece);
  }
  const text = draftText(rows, texts, pieces, c.hint);
  // A list pushed the harness's own row down: only the typed command's own list may stand there.
  if (listed && ownListUnder(texts, bottom, text, idle.volatile.below.commandList) === null) return null;

  const label = topMatch.groups?.label?.trim() ?? "";
  const anchorsHit: FrameAnchorHit[] = ["top"];
  if (label.length > 0) anchorsHit.push("label");
  anchorsHit.push("prompt");
  if (hole !== undefined) anchorsHit.push("draft");
  anchorsHit.push("bottom");
  const byText = isPlaceholderText(text, idle);
  const bySgr = prompt <= last && holeIsFaint(rows, prompt, holeStart, last, idle.placeholders.sgr);
  if (byText) anchorsHit.push("placeholder-text");
  if (bySgr) anchorsHit.push("placeholder-sgr");

  let end = texts.length;
  while (end > bottom + 1 && isBlank(texts[end - 1]!)) end--;
  // An open box has no edge to walk a statusline from: rows under it (a widget) stay in the cues' sight.
  const { status, footer, named } = open ? { status: null, footer: null, named: [] } : walkBelowNamed(texts, bottom, end, idle, c.footerRows);
  const above = bandAbove(texts, top, idle);

  return {
    top,
    bottom,
    label: label.length > 0 ? label : null,
    interior: { first: top + 1, prompt, last: open ? bottom : bottom - 1, text },
    placeholder: byText || bySgr,
    volatile: { above, status, footer, named },
    anchorsHit,
  };
}

const compiledOverlays = new WeakMap<IdleProfile, readonly RegExp[]>();

/**
 * Whether a dialog is drawn over the screen above the frame: a row above the top edge matches one of
 * the profile's `overlayRows`. The box stays on screen under such a dialog, so the frame alone would
 * read free. False for a profile with no such rows.
 */
export function coveredFrame(rows: readonly FrameRow[], frame: Frame, idle: IdleProfile): boolean {
  const sources = idle.overlayRows;
  if (sources === undefined || sources.length === 0) return false;
  let patterns = compiledOverlays.get(idle);
  if (patterns === undefined) {
    patterns = sources.map((source) => new RegExp(source, "u"));
    compiledOverlays.set(idle, patterns);
  }
  for (let i = 0; i < frame.top && i < rows.length; i++) {
    const text = rowText(rows[i]!).trimEnd();
    if (text.length > 0 && patterns.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

/**
 * The input frame on a screen read, or null.
 *
 * The bottom edge is the lowest row that matches the bottom anchor at its column, at most
 * `maxTailRows` rows above the last non-blank row. Only that row is tried: when its frame does not
 * close, there is no frame. A box higher up is an echo in the transcript, not the live one. A box
 * with blank edges (no edge glyphs) is read strictly: every interior row is blank or indented, the
 * blank top edge sits straight over the prompt row, and two blank rows in a row end the box.
 */
export function findInputFrame(rows: readonly FrameRow[], idle: IdleProfile): Frame | null {
  const found = findLayout(rows, idle);
  if (found !== null || idle.frameAlternates === undefined) return found;
  for (const alternate of alternatesOf(idle)) {
    const hit = findLayout(rows, alternate);
    if (hit !== null) return hit;
  }
  return null;
}

const compiledAlternates = new WeakMap<IdleProfile, readonly IdleProfile[]>();

/** The profile's other frame shapes, each as an idle block of its own with the main shape swapped for it. */
function alternatesOf(idle: IdleProfile): readonly IdleProfile[] {
  const known = compiledAlternates.get(idle);
  if (known !== undefined) return known;
  const list = (idle.frameAlternates ?? []).map((frame): IdleProfile => Object.assign({}, idle, { frame, frameAlternates: undefined }));
  compiledAlternates.set(idle, list);
  return list;
}

/**
 * The frame of an open box over the last non-blank row `end - 1`. Each row passed over on the way up
 * is blank or a row the profile's `rows` pattern does not accept: a row the box draws (an edge, a draft
 * row) is never passed, so a read cut inside the box still finds no frame.
 */
function openFrame(rows: readonly FrameRow[], end: number, idle: IdleProfile): Frame | null {
  const under = compile(idle).interior.rows;
  for (let b = end - 1; b >= 0 && end - 1 - b <= idle.frame.maxTailRows; b--) {
    const frame = interiorFrameAt(rows, b, idle);
    if (frame !== null) return frame;
    const text = rowText(rows[b]!);
    if (under === null || (!isBlank(text) && under.test(text.trimEnd()))) return null;
  }
  return null;
}

function findLayout(rows: readonly FrameRow[], idle: IdleProfile): Frame | null {
  const c = compile(idle);
  let end = rows.length;
  while (end > 0 && isBlank(rowText(rows[end - 1]!))) end--;
  // An open box has no bottom edge: its last row is the last row of the screen, or a row at most
  // `maxTailRows` above it when rows the box never draws stand under it (an extension's widget, #468).
  if (c.bottom.open) return openFrame(rows, end, idle) ?? listedLayout(rows, end, idle);
  for (let b = end - 1; b >= 0 && end - 1 - b <= idle.frame.maxTailRows; b--) {
    if (anchored(rowText(rows[b]!), c.bottom) !== null) return frameAt(rows, b, idle);
  }
  return listedLayout(rows, end, idle);
}

/** How far up from the screen's end a box past its own command list is looked for: a list and its footer are never taller. */
const LISTED_REACH = 64;

/**
 * The box over the typed command's own list (`idle.volatile.below.commandList`), when the search at the
 * screen's end found none: a list taller than `maxTailRows` pushes the box's bottom edge, or an open
 * box's last row, out of that search's reach. The row right over the list is tried as that edge, and
 * the box found there is kept only when the list's pointer rests on exactly the box's text. A list that
 * points at another command, or at none, finds no box here.
 */
function listedLayout(rows: readonly FrameRow[], end: number, idle: IdleProfile): Frame | null {
  const list = idle.volatile.below.commandList;
  if (list === undefined) return null;
  const texts = rows.map(rowText);
  const bottom = listedBottom(texts, end, LISTED_REACH, list);
  if (bottom === null) return null;
  const c = compile(idle);
  const frame = c.bottom.open ? interiorFrameAt(rows, bottom, idle) : anchored(texts[bottom]!, c.bottom) === null ? null : frameAt(rows, bottom, idle);
  if (frame === null || frame.placeholder) return null;
  return ownListUnder(texts, bottom, frame.interior.text, list) === null ? null : frame;
}

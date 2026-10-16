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
import type { FrameAnchor, Profile } from "./profile";

/** The profile block this module reads. */
export type IdleProfile = Profile["idle"];

/** One styled run of a row. The attribute flags are the SGR ones the placeholder test can name. */
export interface FrameRun {
  readonly text: string;
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
   *  `named` lists every row under the bottom edge that one of the profile's named footer rows
   *  matches (`idle.volatile.below.footerRows`), walk or not: no modal cue reads these rows. */
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
      continuation: continuation === undefined ? null : new RegExp(continuation, "u"),
      under: under === undefined ? null : new RegExp(under, "u"),
    },
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

/** The statusline run and the footer under the bottom edge (`Frame.volatile`). */
interface BelowRun {
  readonly status: RowSpan | null;
  readonly footer: RowSpan | null;
}

/** The profile's name for a row under the box, or null when no named footer row matches it. */
function footerRowName(text: string, rows: readonly CompiledFooterRow[]): string | null {
  if (rows.length === 0 || isBlank(text)) return null;
  const trimmed = text.trimEnd();
  return rows.find((row) => row.pattern.test(trimmed))?.name ?? null;
}

/**
 * The run under the bottom edge with the profile's named footer rows. First the named run at the
 * bottom: named rows and blank rows up from the last row. It starts after the blank row that sets it
 * apart, so a named row joined to the rows above it (a hint on a statusline row) stays with them.
 * That run is a footer, whatever its height. The rows above it walk as before ({@link walkBelow}).
 * A walk that fails still fails: the named run never makes a popup or a dialog a statusline.
 */
function walkBelowNamed(texts: readonly string[], bottom: number, end: number, idle: IdleProfile, named: readonly NamedRow[]): BelowRun {
  const below = idle.volatile.below;
  if (named.length === 0) return walkBelow(texts, bottom, end, below);
  const isNamed = new Set(named.map((hit) => hit.row));
  let j = end - 1;
  while (j > bottom && (isBlank(texts[j]!) || isNamed.has(j))) j--;
  let first = j + 1;
  while (first < end && !isBlank(texts[first]!)) first++;
  while (first < end && isBlank(texts[first]!)) first++;
  if (first >= end) return walkBelow(texts, bottom, end, below);
  let rest = first;
  while (rest > bottom + 1 && isBlank(texts[rest - 1]!)) rest--;
  const run = walkBelow(texts, bottom, rest, below);
  if (run.status === null && run.footer === null && rest > bottom + 1) return run;
  return { status: run.status, footer: { first: run.footer?.first ?? first, last: end - 1 } };
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
  const parts = [(hole ?? "").trim()];
  for (let j = prompt + 1; j < bottom; j++) {
    const part = texts[j]!.trim();
    if (part.length > 0) parts.push(part);
  }
  const text = parts.join(" ").trim();
  anchorsHit.push("bottom");

  const byText = isPlaceholderText(text, idle);
  const bySgr = holeIsFaint(rows, prompt, holeStart, bottom - 1, idle.placeholders.sgr);
  if (byText) anchorsHit.push("placeholder-text");
  if (bySgr) anchorsHit.push("placeholder-sgr");

  let end = texts.length;
  while (end > bottom + 1 && isBlank(texts[end - 1]!)) end--;
  const named = namedRowsBelow(texts, bottom, end, c);
  const { status, footer } = walkBelowNamed(texts, bottom, end, idle, named);
  const aboveRows = Math.min(idle.volatile.above.maxRows, top);
  const above = aboveRows > 0 ? { first: top - aboveRows, last: top - 1 } : null;

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

/** The text a row adds to the draft on the interior walk: the profile's `text` group, or the trimmed row. */
function interiorPiece(text: string, continuation: RegExp | null): string {
  const hit = continuation?.exec(text.trimEnd())?.groups?.text;
  return (hit ?? (continuation === null ? text : "")).trim();
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
  if (c.interior.under !== null && !open) {
    // The row the harness always draws under its box: the first row there that is not blank.
    const under = texts.slice(bottom + 1).find((text) => !isBlank(text));
    if (under !== undefined && !c.interior.under.test(under.trimEnd())) return null;
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
  const parts: string[] = [];
  for (let j = top + 1; j <= last; j++) {
    const piece = j === prompt ? (hole ?? "").trim() : interiorPiece(texts[j]!, c.interior.continuation);
    if (piece.length > 0) parts.push(piece);
  }
  const text = parts.join(" ").trim();

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
  // An open box ends on the screen's last row, so nothing is under it to walk or name.
  const named = open ? [] : namedRowsBelow(texts, bottom, end, c);
  const { status, footer } = open ? { status: null, footer: null } : walkBelowNamed(texts, bottom, end, idle, named);
  const aboveRows = Math.min(idle.volatile.above.maxRows, top);
  const above = aboveRows > 0 ? { first: top - aboveRows, last: top - 1 } : null;

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

/** The rows under the bottom edge that match one of the profile's footer rows, with their names. */
function namedRowsBelow(texts: readonly string[], bottom: number, end: number, c: Compiled): NamedRow[] {
  const named: NamedRow[] = [];
  for (let j = bottom + 1; j < end; j++) {
    const name = footerRowName(texts[j]!, c.footerRows);
    if (name !== null) named.push({ row: j, name });
  }
  return named;
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

function findLayout(rows: readonly FrameRow[], idle: IdleProfile): Frame | null {
  const c = compile(idle);
  let end = rows.length;
  while (end > 0 && isBlank(rowText(rows[end - 1]!))) end--;
  // An open box has no bottom edge: its last row is the last row of the screen.
  if (c.bottom.open) return end === 0 ? null : interiorFrameAt(rows, end - 1, idle);
  for (let b = end - 1; b >= 0 && end - 1 - b <= idle.frame.maxTailRows; b--) {
    if (anchored(rowText(rows[b]!), c.bottom) !== null) return frameAt(rows, b, idle);
  }
  return null;
}

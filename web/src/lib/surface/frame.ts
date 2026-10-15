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
   *  `status` and `footer` are the run under the bottom edge, when the rows there walk as one. */
  readonly volatile: {
    readonly above: RowSpan | null;
    readonly status: RowSpan | null;
    readonly footer: RowSpan | null;
  };
  readonly anchorsHit: readonly FrameAnchorHit[];
}

interface Compiled {
  readonly top: RegExp;
  readonly topCells: number;
  readonly prompt: RegExp;
  readonly promptCells: number;
  readonly bottom: RegExp;
  readonly bottomCells: number;
}

const compiledByIdle = new WeakMap<IdleProfile, Compiled>();

function cellFloor(anchor: FrameAnchor): number {
  return anchor.minCells ?? 0;
}

function compile(idle: IdleProfile): Compiled {
  const known = compiledByIdle.get(idle);
  if (known !== undefined) return known;
  const { top, prompt, bottom } = idle.frame;
  const compiled: Compiled = {
    top: new RegExp(top.pattern, "u"),
    topCells: cellFloor(top),
    // `d` gives the draft hole's offset, so the placeholder test reads only the runs inside it.
    prompt: new RegExp(prompt.pattern, "du"),
    promptCells: cellFloor(prompt),
    bottom: new RegExp(bottom.pattern, "u"),
    bottomCells: cellFloor(bottom),
  };
  compiledByIdle.set(idle, compiled);
  return compiled;
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

/** Whether an anchor matches a row: the row starts in the anchor's column (0, so no leading space),
 *  the pattern matches the row with its trailing space cut, and the row spans at least `minCells`. */
function anchored(text: string, pattern: RegExp, minCells: number): RegExpExecArray | null {
  if (text.length === 0 || /^\s/u.test(text)) return null;
  const trimmed = text.trimEnd();
  if (minCells > 0 && displayWidth(trimmed) < minCells) return null;
  return pattern.exec(trimmed);
}

/** The edge a row is, as the frame walk sees it: one of the three anchors, at column 0. A row that
 *  matches the bottom anchor also matches the top one on a bare edge; the walk only needs to know
 *  it is an edge. */
export function frameEdge(text: string, idle: IdleProfile): "prompt" | "bottom" | "top" | null {
  const c = compile(idle);
  if (anchored(text, c.prompt, c.promptCells) !== null) return "prompt";
  if (anchored(text, c.bottom, c.bottomCells) !== null) return "bottom";
  if (anchored(text, c.top, c.topCells) !== null) return "top";
  return null;
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

/** The statusline run and the footer under the bottom edge (`Frame.volatile`). */
interface BelowRun {
  readonly status: RowSpan | null;
  readonly footer: RowSpan | null;
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
  const bottomText = texts[bottom];
  if (bottomText === undefined || anchored(bottomText, c.bottom, c.bottomCells) === null) return null;

  const budget = idle.frame.maxDraftRows;
  let crossed = 0;
  let i = bottom - 1;
  while (i >= 0 && frameEdge(texts[i]!, idle) === null && crossed < budget) {
    crossed++;
    i--;
  }
  if (i < 0) return null;
  const promptMatch = anchored(texts[i]!, c.prompt, c.promptCells);
  if (promptMatch === null) return null;
  const prompt = i;
  i--;
  while (i >= 0 && isBlank(texts[i]!) && crossed < budget) {
    crossed++;
    i--;
  }
  if (i < 0) return null;
  const topMatch = anchored(texts[i]!, c.top, c.topCells);
  if (topMatch === null) return null;
  const top = i;

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

  const byText = text.length > 0 && idle.placeholders.texts.includes(text);
  const bySgr = holeIsFaint(rows, prompt, holeStart, bottom - 1, idle.placeholders.sgr);
  if (byText) anchorsHit.push("placeholder-text");
  if (bySgr) anchorsHit.push("placeholder-sgr");

  let end = texts.length;
  while (end > bottom + 1 && isBlank(texts[end - 1]!)) end--;
  const { status, footer } = walkBelow(texts, bottom, end, idle.volatile.below);
  const aboveRows = Math.min(idle.volatile.above.maxRows, top);
  const above = aboveRows > 0 ? { first: top - aboveRows, last: top - 1 } : null;

  return {
    top,
    bottom,
    label: label.length > 0 ? label : null,
    interior: { first: top + 1, prompt, last: bottom - 1, text },
    placeholder: byText || bySgr,
    volatile: { above, status, footer },
    anchorsHit,
  };
}

/**
 * The input frame on a screen read, or null.
 *
 * The bottom edge is the lowest row that matches the bottom anchor at column 0, at most
 * `maxTailRows` rows above the last non-blank row. Only that row is tried: when its frame does not
 * close, there is no frame. A box higher up is an echo in the transcript, not the live one.
 */
export function findInputFrame(rows: readonly FrameRow[], idle: IdleProfile): Frame | null {
  const c = compile(idle);
  let end = rows.length;
  while (end > 0 && isBlank(rowText(rows[end - 1]!))) end--;
  for (let b = end - 1; b >= 0 && end - 1 - b <= idle.frame.maxTailRows; b--) {
    if (anchored(rowText(rows[b]!), c.bottom, c.bottomCells) !== null) return frameAt(rows, b, idle);
  }
  return null;
}

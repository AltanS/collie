// The canonical styled projection is shared with the phone, which builds the value this verifies.
// It is pure and sits under web/src/lib beside the one SGR parser it is built on; the bridge imports
// it by relative path, as scripts/harness-canary/ does for web/src/lib/json.
import { decodeStyledRegion, STYLED_FORMAT, styledRegionLines } from "../web/src/lib/styled-region.ts";
// The column range of a bound region (`expected_columns`) is cut by one function shared the same way.
import { cropRawColumns, type ColumnRange } from "../web/src/lib/column-range.ts";
// The task checklist Claude Code 2.1.299 draws under a dialog is recognised by the one function the
// phone uses to take it off before its grammars run.
import { trailingTaskChecklistStart } from "../web/src/lib/task-checklist.ts";
// The input box is found by the one input-frame module (M56 spec 03), from every harness profile's
// anchors. It feeds a SHADOW observation only (composerBelowShadow); it never refuses a tap.
import { findInputFrame, plainRows } from "../web/src/lib/surface/frame.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";

/**
 * Normalize a rendered prompt region for comparison across terminal redraws.
 *
 * A terminal redraw can append trailing padding or change blank-line layout without changing the
 * question, so trailing whitespace and blank lines are ignored. Leading indentation and internal
 * alignment must survive because they can be semantic content in a displayed diff or command.
 */
// The two control characters are spliced in from their code points rather than written as escapes
// in the literal: matching them IS the point here, and a regex literal that says so is (correctly)
// flagged as suspicious wherever it isn't. `\x1b[` is the 7-bit CSI, `\x9b` its 8-bit form.
const CSI = `(?:${String.fromCodePoint(0x1b)}\\[|${String.fromCodePoint(0x9b)})`;
const SGR_SEQUENCE = new RegExp(`${CSI}[0-?]*[ -/]*m`, "g");

export function normalizePromptRegion(text: string): string[] {
  return text
    .replace(SGR_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

// Across all 20 committed fixture regions, at most one normalized line follows a match. Six lines
// leave generous headroom for a status or spinner update while ensuring a replacement prompt, whose
// regions span 20 to 32 normalized lines, pushes a stale match outside the accepted tail. A task
// checklist at the very end of the read (Claude Code 2.1.299 draws it under a dialog's footer) is not
// counted: it ran to seven rows in the 2.1.299 captures (the header, five tasks and the `… +N`
// overflow row Claude folds the rest into) and would push every live region out. Only a list whose counts
// agree with its header is skipped (`trailingTaskChecklistStart`), so output that merely looks like
// one still counts. Nor is the footer run a profile names under its input box counted, for a region
// that ends above it (Claude Code's agents panel, one row per background agent; `matchText`). Those
// are the only rows the window skips, and only rows a reader recognizes: plain output under a box
// still counts, with a blank row over it or not.
export const DEFAULT_PROMPT_TAIL_LINES = 6;

export type PromptBindingResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "not_found" | "not_in_tail" };

/** The reasons the style check refuses with. Spelled apart from the text check's so an audit line
 *  says which of the two refused. */
export type StyledRefusal = "style_empty" | "style_not_found" | "style_misaligned";

/** What the style check did on an accepted binding: `checked`, or `skipped_unknown_version` when the
 *  phone's value names a format this bridge does not know (the text check alone then decided). */
export type StyledOutcome = "checked" | "skipped_unknown_version";

/** The one verdict of {@link verifyPromptBinding}. `styled` is present exactly when the caller gave a
 *  styled value. */
export type PromptBindingVerdict =
  | { ok: true; styled?: StyledOutcome }
  | { ok: false; reason: Extract<PromptBindingResult, { ok: false }>["reason"] | StyledRefusal };

/** The verdict of {@link verifyExpectedStyled}: the strict form for a caller that needs the style
 *  actually checked, so an unknown format version is a refusal here (`style_unchecked`). */
export type StyledBindingResult =
  | { ok: true }
  | { ok: false; reason: Extract<PromptBindingVerdict, { ok: false }>["reason"] | "style_unchecked" };

/**
 * Find `expected` as a contiguous run of `fresh` lines, the LAST such run, and require it to end
 * inside the last `tailLines` lines. Returns where the run starts, so the style check can look at the
 * same place. The caller has already cut a trailing task checklist and a named footer run off `fresh`
 * (see `matchText`).
 */
function matchInTail(
  fresh: string[],
  expected: string[],
  tailLines: number,
): { ok: true; start: number } | { ok: false; reason: "not_found" | "not_in_tail" } {
  let lastMatch = -1;
  candidate: for (let start = 0; start <= fresh.length - expected.length; start++) {
    for (let offset = 0; offset < expected.length; offset++) {
      if (fresh[start + offset] !== expected[offset]) continue candidate;
    }
    lastMatch = start;
  }
  if (lastMatch === -1) return { ok: false, reason: "not_found" };

  const boundedTailLines = Math.max(0, Math.floor(tailLines));
  const tailStart = Math.max(0, fresh.length - boundedTailLines);
  const matchEnd = lastMatch + expected.length - 1;
  if (matchEnd < tailStart) return { ok: false, reason: "not_in_tail" };
  return { ok: true, start: lastMatch };
}

type TextRefusal = Extract<PromptBindingResult, { ok: false }>["reason"];

/** The read's rows with every SGR escape stripped, blank rows kept, as the input-frame module walks them. */
function plainReadRows(freshText: string): string[] {
  return freshText.replace(SGR_SEQUENCE, "").replace(/\r\n?/g, "\n").split("\n");
}

/** How many rows above `row` survive `normalizePromptRegion`: the normalized index of `row`. */
function normalizedIndex(rows: readonly string[], row: number): number {
  let index = 0;
  for (let r = 0; r < row; r++) if (rows[r]!.replace(/\s+$/, "").length > 0) index++;
  return index;
}

/**
 * The normalized index of the first row of the footer run a profile names under an input box (Claude
 * Code's agents panel, `Frame.volatile.named`), or null when no frame names one. Only a profile that
 * declares `idle.volatile.below.footerRows` can name a run (claude.json alone today), so only those
 * are asked, and the first whose frame names one decides, since the route does not know the pane's
 * harness. The frame's generic footer (`Frame.volatile.footer`, any short run after a blank row) is
 * never the cut: plain output under a box that is no longer live would pass as one.
 */
function namedFooterStart(freshText: string): number | null {
  const rows = plainReadRows(freshText);
  for (const profile of loadProfiles().values()) {
    if (profile.idle.volatile.below.footerRows === undefined) continue;
    const first = findInputFrame(plainRows(rows), profile.idle)?.volatile.named[0];
    if (first !== undefined) return normalizedIndex(rows, first.row);
  }
  return null;
}

/**
 * The text check on the normalized lines of `freshText`: where the expected region starts, or why
 * not. A task checklist that ends the read is not counted against the tail (`DEFAULT_PROMPT_TAIL_LINES`).
 * Nor is the footer run a profile names under its input box (`namedFooterStart`), for a region that
 * ends above that run. It is cut only when the read is refused `not_in_tail` without the cut, and a
 * region the cut leaves out of the tail, or unfound, keeps that first verdict: the cut can turn that
 * one refusal into a binding and changes no other verdict. No named run, no cut.
 * Only the end is cut, so the start returned still indexes `freshLines`.
 */
function matchText(
  freshText: string,
  freshLines: string[],
  expected: string,
  tailLines: number,
): { ok: true; start: number } | { ok: false; reason: TextRefusal } {
  const expectedLines = normalizePromptRegion(expected);
  if (expectedLines.length === 0) return { ok: false, reason: "empty" };
  const end = trailingTaskChecklistStart(freshLines) ?? freshLines.length;
  const match = matchInTail(freshLines.slice(0, end), expectedLines, tailLines);
  if (match.ok || match.reason !== "not_in_tail") return match;
  const footerStart = namedFooterStart(freshText);
  if (footerStart === null || footerStart >= end) return match;
  const aboveFooter = matchInTail(freshLines.slice(0, footerStart), expectedLines, tailLines);
  return aboveFooter.ok ? aboveFooter : match;
}

export function verifyExpectedPrompt(
  freshText: string,
  expected: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingResult {
  const match = matchText(freshText, normalizePromptRegion(freshText), expected, tailLines);
  return match.ok ? { ok: true } : { ok: false, reason: match.reason };
}

/**
 * The whole binding verdict for one read: the text check, then, when the phone sent a styled value,
 * the style check AT THE SAME PLACE (ADR 0080 point 7).
 *
 * When the phone named a column range (`expected_columns`, `PromptModel.bindColumns`), every row of
 * the fresh read is first cut to those columns (`cropRawColumns`), and both checks then run on the
 * cut read exactly as below. So a change outside the range, such as Oh My Pi's side panel ticking
 * beside a question, does not refuse the tap, and a change inside it does. The cut is applied to the
 * whole read, not only to the matched rows: the bridge does not know which rows match until it has
 * compared them. Rows the cut leaves empty drop out of both projections alike, so the tail bound
 * counts the rows that carry text inside the range. Without a range the read is compared whole.
 *
 * The text check is `verifyExpectedPrompt`'s: the last contiguous match of the normalized expected
 * lines, ending inside the last `tailLines`. The style check does not search. The two projections
 * drop the same lines (a line with no visible text is dropped by both), so the normalized text lines
 * and the canonical styled lines of one read have the same count and aligned indices. The expected
 * styled lines must therefore equal the fresh styled lines exactly at the index where the text
 * matched. A search of its own could match a stale copy of the region higher up in the buffer, in a
 * pointer state the screen no longer shows, while the text matched the live copy below.
 *
 *   - `style_misaligned`: the fresh read's two projections differ in length, so no index means the
 *     same line in both. Refused, never guessed at.
 *   - `style_not_found`: the styled lines at the text's index differ from the expected ones, or the
 *     expected ones are not as many as the expected text lines.
 *   - `style_empty`: the styled value holds no lines.
 *   - a value whose first line is not the format this bridge knows (`STYLED_FORMAT`) is neither an
 *     error nor a refusal: the style check is skipped and the verdict says so. A newer phone must not
 *     have every tap of an older bridge refused.
 */
export function verifyPromptBinding(
  readText: string,
  expected: string,
  expectedStyled?: string,
  columns?: ColumnRange,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingVerdict {
  const freshText = columns === undefined ? readText : cropRawColumns(readText, columns);
  const freshLines = normalizePromptRegion(freshText);
  const match = matchText(freshText, freshLines, expected, tailLines);
  if (!match.ok) return { ok: false, reason: match.reason };
  if (expectedStyled === undefined) return { ok: true };

  const decoded = decodeStyledRegion(expectedStyled);
  if (decoded === null || (decoded.version === STYLED_FORMAT && decoded.lines.length === 0)) {
    return { ok: false, reason: "style_empty" };
  }
  if (decoded.version !== STYLED_FORMAT) return { ok: true, styled: "skipped_unknown_version" };

  const freshStyled = styledRegionLines(freshText);
  if (freshStyled.length !== freshLines.length) return { ok: false, reason: "style_misaligned" };
  const expectedLineCount = normalizePromptRegion(expected).length;
  if (decoded.lines.length !== expectedLineCount) return { ok: false, reason: "style_not_found" };
  for (let offset = 0; offset < decoded.lines.length; offset++) {
    if (freshStyled[match.start + offset] !== decoded.lines[offset]) {
      return { ok: false, reason: "style_not_found" };
    }
  }
  return { ok: true, styled: "checked" };
}

/** The refusal a shadow observation WOULD give. It is recorded in the audit line, never returned as a
 *  verdict (see {@link composerBelowShadow}). */
export type BindingShadow = "composer_below";

/**
 * SHADOW MODE (M56 spec 03, README rule "new behaviour ships behind a flag or in shadow mode
 * first"): whether a harness input box is drawn BELOW the region a passing binding matched. The input
 * frame comes from the one input-frame module with each profile's anchors, because the route does not
 * know the pane's harness. The idea is that a dialog replaces the composer while it is up, so a box
 * under the region would mean the dialog has closed. That premise is FALSE for a harness that draws
 * its question inline above its own composer: Muse draws Claude's box under a live question, and
 * every live Muse question in the corpus trips this. So the answer is never a refusal. The route
 * records it in the audit line (`promptBinding.shadow`) so the counters can measure it, and
 * {@link verifyPromptBinding} is unchanged. Turning it into a refusal needs the pane's profile (from
 * the binary, never the screen) and a measured miss rate.
 *
 * Takes the same arguments as {@link verifyPromptBinding} and answers `undefined` when the text check
 * does not pass, so a caller may run it after any verdict.
 */
export function composerBelowShadow(
  readText: string,
  expected: string,
  columns?: ColumnRange,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): BindingShadow | undefined {
  const freshText = columns === undefined ? readText : cropRawColumns(readText, columns);
  const match = matchText(freshText, normalizePromptRegion(freshText), expected, tailLines);
  if (!match.ok) return undefined;
  const matchEnd = match.start + normalizePromptRegion(expected).length - 1;
  const rows = freshText.replace(SGR_SEQUENCE, "").replace(/\r\n?/g, "\n").split("\n");
  for (const profile of loadProfiles().values()) {
    const frame = findInputFrame(plainRows(rows), profile.idle);
    if (frame === null) continue;
    // The normalized index of the top edge: the non-blank rows above it, as normalizePromptRegion
    // keeps them. The top edge itself is never blank. A frame ABOVE the region says nothing.
    let topLine = 0;
    for (let r = 0; r < frame.top; r++) if (rows[r]!.replace(/\s+$/, "").length > 0) topLine++;
    if (topLine > matchEnd) return "composer_below";
  }
  return undefined;
}

/**
 * The style check as a pass/fail for a caller that must know the style WAS checked (the conformance
 * suite): {@link verifyPromptBinding} on the model's text and its styled value, with an unknown
 * format version reported as `style_unchecked` instead of an acceptance.
 */
export function verifyExpectedStyled(
  freshText: string,
  expected: string,
  expectedStyled: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): StyledBindingResult {
  const verdict = verifyPromptBinding(freshText, expected, expectedStyled, undefined, tailLines);
  if (!verdict.ok) return verdict;
  if (verdict.styled !== "checked") return { ok: false, reason: "style_unchecked" };
  return { ok: true };
}

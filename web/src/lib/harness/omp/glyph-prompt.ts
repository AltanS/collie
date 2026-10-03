// OMP's two `❯`-gutter composers that the `rule` and `pi` scanners do not read: `composer.shape:
// claude` and `composer.shape: borderless` (issue #343, captured on omp v18.4.10, `omp--v18-4-claude-*`
// and `omp--v18-4-borderless-*`). Before this file neither shape had a locator, so `composerReady` was
// false on every frame and every Send asked "Type anyway?".
//
// `claude`, rendered by pi-tui's composer styles (`claudeComposerStyle`):
//
//   ──────────────────────────── <session title> ─     top rule, the title chip right-aligned
//                                                       (omp 18.3.0, from the issue's paste: no closing ─)
//   ❯ <first draft row>                                 the prompt row, or `❯` alone when empty
//     <wrapped continuation rows>                       two-space gutter, blank rows are blank lines
//   ────────────────────────────────────────────────    bottom rule, in the SAME colour as the top
//                                                       (the 18.3.0 paste draws it shorter than the top)
//    π · <field> · <field> · …                          the status row, final non-blank row
//
// `borderless`, rendered by `borderlessComposerStyle`:
//
//   ❯ <first draft row>
//     <wrapped continuation rows>
//    π · <field> · <field> · …                          the status row, final non-blank row
//
// The borderless shape has no rule at all, so its only anchor is the tail: the `❯` row and its
// continuations directly above a styled status row that is the last thing on screen. That is thin
// evidence, so it is confined to a tail no other shape shares, and every refusal is a null, which
// costs a refused send and never a keystroke. The registry only hands this adapter a pane Herdr
// labelled omp, and the rejection cohorts (every omp modal and every foreign capture) are asserted
// to decline in omp.test.ts.
//
// The 18.3.0 form (a titled top rule with no closing rule glyph after the title, and a bottom rule
// shorter than the top) is accepted from the issue's description, not from a capture: every capture
// here is 18.4.10, whose titled top rule ends ` Title ─`. The top rule therefore needs only a run of
// rule glyphs at its start, and the bottom rule needs only a run, never a full width.
//
// Both shapes paint omp's empty-editor key hint right-aligned on the prompt row and an inline
// completion suggestion after the draft, so the draft reader applies the same `draftPlaceholder` and
// `draftGhost` rules the `rule` scanner does (markers.ts).

import type { StyledLine } from "../../blocks";
import { draftGhost, draftPlaceholder, isBlank, lineText, opensBox, rstrip } from "./markers";
import { ompModalOnScreen } from "./modal";

const PROMPT = /^❯(?: ([\s\S]*))?$/;
/** A wrapped row: the two-space gutter, then the text. `claude` also draws blank draft lines. */
const CONTINUATION = /^ {2}([\s\S]*)$/;
const CONTINUATION_TEXT = /^ {2}[\s\S]*\S$/;
/**
 * The top rule: a run of at least eight rule glyphs at the start of the row, optionally followed by
 * the title chip, with or without a closing rule glyph. 18.4.10 closes the title with ` ─`; the
 * 18.3.0 form, from issue #343's description and not from a capture, does not. The colour match
 * with the bottom rule carries the rest of the evidence.
 */
const TOP_RULE = /^─{8,}/;
const BOTTOM_RULE = /^─{8,}$/;
/** omp indents its status row by exactly one space. A palette row or a draft row has two. */
const STATUS_LEAD = /^ \S/;
/** One separator glyph, painted as a segment of its own: the `statusLine.separator` presets. */
const SEPARATOR = /^[·|/>›»│\u{e0b0}-\u{e0b3}]$/u;
const MAX_DRAFT_ROWS = 100;

export interface GlyphComposer {
  style: "claude" | "borderless";
  /** The top rule row, `claude` only. */
  top: number | null;
  promptStart: number;
  promptEnd: number;
  status: number;
}

function lastNonBlank(lines: StyledLine[]): number {
  let row = lines.length - 1;
  while (row >= 0 && isBlank(lineText(lines[row]!))) row--;
  return row;
}

/**
 * The renderer's own status row: a single leading space, then styled fields joined by a separator
 * glyph that is a segment of its own. A transcript line, a shell prompt, a palette row or a hint
 * footer is not painted that way, which is what keeps a `❯` above one of them from reading as a
 * composer.
 */
function isStatusRow(line: StyledLine): boolean {
  const text = rstrip(lineText(line));
  if (!STATUS_LEAD.test(text) || opensBox(text)) return false;
  return line.segments.some((s) => s.fg !== undefined && SEPARATOR.test(s.text.trim()));
}

function ruleColour(line: StyledLine): string | undefined {
  return line.segments.find((s) => s.text.trim() !== "")?.fg;
}

/** Locate omp's `claude`-shaped composer at the buffer tail, or null. */
export function locateClaudeComposer(lines: StyledLine[]): GlyphComposer | null {
  const status = lastNonBlank(lines);
  if (status < 3 || !isStatusRow(lines[status]!)) return null;
  const bottom = status - 1;
  if (!BOTTOM_RULE.test(rstrip(lineText(lines[bottom]!)))) return null;

  let promptStart = bottom - 1;
  while (promptStart >= 1) {
    const text = rstrip(lineText(lines[promptStart]!));
    if (PROMPT.test(text)) break;
    if (text !== "" && !CONTINUATION.test(text)) return null;
    if (bottom - promptStart > MAX_DRAFT_ROWS) return null;
    promptStart--;
  }
  const top = promptStart - 1;
  if (promptStart < 1 || !TOP_RULE.test(rstrip(lineText(lines[top]!)))) return null;
  if (ruleColour(lines[top]!) !== ruleColour(lines[bottom]!)) return null;
  if (ompModalOnScreen(lines)) return null;
  return { style: "claude", top, promptStart, promptEnd: bottom - 1, status };
}

/** Locate omp's `borderless` composer at the buffer tail, or null. */
export function locateBorderlessComposer(lines: StyledLine[]): GlyphComposer | null {
  const status = lastNonBlank(lines);
  if (status < 1 || !isStatusRow(lines[status]!)) return null;

  const promptEnd = status - 1;
  let promptStart = promptEnd;
  while (promptStart >= 0 && CONTINUATION_TEXT.test(rstrip(lineText(lines[promptStart]!)))) {
    if (promptEnd - promptStart >= MAX_DRAFT_ROWS) return null;
    promptStart--;
  }
  if (promptStart < 0 || !PROMPT.test(rstrip(lineText(lines[promptStart]!)))) return null;
  if (ompModalOnScreen(lines)) return null;
  return { style: "borderless", top: null, promptStart, promptEnd, status };
}

/** Either shape, or null. They never share a tail: one has a bottom rule, the other has none. */
export function locateGlyphComposer(lines: StyledLine[]): GlyphComposer | null {
  return locateClaudeComposer(lines) ?? locateBorderlessComposer(lines);
}

export function stripGlyphChrome(lines: StyledLine[], composer: GlyphComposer): StyledLine[] {
  let end = composer.top ?? composer.promptStart;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines.slice(0, end);
}

export function extractGlyphStatusLines(lines: StyledLine[], composer: GlyphComposer): StyledLine[] {
  return [lines[composer.status]!];
}

export function glyphComposerPrompt(lines: StyledLine[], composer: GlyphComposer): string {
  return lines
    .slice(composer.promptStart, composer.promptEnd + 1)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}

export function extractGlyphInputDraft(lines: StyledLine[], composer: GlyphComposer): string | null {
  const parts: string[] = [];
  for (let row = composer.promptStart; row <= composer.promptEnd; row++) {
    const text = rstrip(lineText(lines[row]!));
    const match = row === composer.promptStart ? PROMPT.exec(text) : CONTINUATION.exec(text);
    if (match === null) {
      if (row !== composer.promptStart && text === "") {
        parts.push("");
        continue;
      }
      return null;
    }
    parts.push(match[1] ?? "");
  }

  const last = parts.length - 1;
  const tail = parts[last]!;
  const lastLine = lines[composer.promptEnd]!;
  if (last === 0 && draftPlaceholder(lastLine, 2, 2 + tail.length)) return null;
  const ghost = draftGhost(lastLine, 2, 2 + tail.length);
  if (ghost.length > 0 && tail.endsWith(ghost)) parts[last] = tail.slice(0, -ghost.length);

  const draft = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return draft.length === 0 ? null : draft;
}

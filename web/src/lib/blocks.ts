// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. `raw` mirrors terminal output verbatim; `prompt-select` lifts a Claude single-choice
// dialog into a typed payload the renderer draws as buttons. The discriminated union is shaped so
// further grammars (tool calls, …) are added as new `kind`s without disturbing these.
//
// The pipeline is: parseAnsi(text) → AnsiSegment[] → splitLines(segments) → StyledLine[] →
// buildBlocks(lines, ctx) → Block[]. These functions are PURE (no React) and, together with the
// parser, run once per unique text (memoised by the renderer), so they're off the hot polling path.
// The Claude-only grammars in buildBlocks (prompt-select detection, chrome stripping) live in
// ./grammar; every other agent keeps pure raw output.
//
// Invariant (relied on by find-in-output): joining every RAW block's line text with "\n" reproduces
// the visible mirror text character-for-character. Find operates on global character offsets over
// that string; a prompt-select block is rendered as buttons, so its text is NOT part of that space
// (find covers the raw mirror only).

import type { AnsiSegment } from "./ansi";
import type { PromptModel } from "./grammar/prompt-select";
import { detectPromptSelectRegion } from "./grammar/prompt-select";
import { stripChrome } from "./grammar/chrome";
import { isBlank, lineText } from "./grammar/markers";

// Re-export the prompt-select model so consumers (the block component, the race guard) have one
// import site for the AST's typed payloads.
export type { PromptModel, PromptOption, PromptFamily } from "./grammar/prompt-select";

/** One visual line: the styled segments that make it up, with the line-terminating "\n" removed. */
export interface StyledLine {
  segments: AnsiSegment[];
}

/** A run of raw terminal output. Renders as verbatim styled text (the T1 mirror). */
export interface RawBlock {
  kind: "raw";
  lines: StyledLine[];
}

/**
 * A single-choice Claude dialog lifted out of the raw mirror and rendered as native buttons. It
 * REPLACES the menu region ([firstOption … tail]) in place; the question and any preamble stay in
 * the raw block above it. `lines` is the raw region it replaced — retained for provenance only; it
 * is NOT rendered as text and NOT part of the find haystack (find runs over raw blocks only).
 */
export interface PromptSelectBlock {
  kind: "prompt-select";
  prompt: PromptModel;
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; new members are added purely additively, so a
 * `switch (block.kind)` in the renderer stays exhaustive.
 */
export type Block = RawBlock | PromptSelectBlock;

/**
 * Split parsed segments into visual lines at "\n" boundaries. The newline characters become the
 * separators *between* lines and are dropped from segment text, so `lines.map(text).join("\n")`
 * reconstructs the original visible string exactly.
 *
 * A segment whose text has no newline is reused as-is (no allocation). A segment carrying newline(s)
 * is sliced into per-line pieces that each keep the original segment's style/flags — so a styled run
 * straddling a line break stays styled on both sides. Empty pieces (adjacent newlines, or a leading/
 * trailing newline) contribute no segment but still open/close a line, preserving blank lines.
 */
export function splitLines(segments: AnsiSegment[]): StyledLine[] {
  const lines: StyledLine[] = [];
  let current: AnsiSegment[] = [];

  for (const seg of segments) {
    const t = seg.text;
    if (t.indexOf("\n") === -1) {
      // Common case (parser flushes at every "\n", so most segments have none): reuse verbatim.
      current.push(seg);
      continue;
    }
    // Segment contains one or more newlines: distribute its text across the lines it spans, cloning
    // the style onto each non-empty piece.
    let start = 0;
    for (;;) {
      const idx = t.indexOf("\n", start);
      const end = idx === -1 ? t.length : idx;
      if (end > start) current.push({ ...seg, text: t.slice(start, end) });
      if (idx === -1) break;
      lines.push({ segments: current });
      current = [];
      start = idx + 1;
    }
  }

  // The trailing run (after the last "\n", or the whole input if it had none) is the final line —
  // pushed even when empty so a trailing newline yields a terminating blank line.
  lines.push({ segments: current });
  return lines;
}

/**
 * Group lines into semantic blocks. This is the seam where Claude-Code TUI grammars run: when
 * `ctx.agent === "claude"` we detect a tail prompt-select dialog (replacing it with a typed block
 * and keeping everything above it raw) and otherwise strip trailing chrome. Any detection miss
 * falls back to a single raw block — the universal T1 behaviour.
 *
 * Gating is conservative: every OTHER agent keeps pure raw output until its own matchers exist, so
 * a non-Claude pane is never mis-parsed. With no `ctx` (or a non-Claude agent) this is the trivial
 * single-raw-block wrap it always was.
 */
export function buildBlocks(lines: StyledLine[], ctx?: { agent?: string }): Block[] {
  if (ctx?.agent !== "claude") return [{ kind: "raw", lines }];

  const region = detectPromptSelectRegion(lines);
  if (region) {
    const before = trimTrailingBlank(lines.slice(0, region.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: region.model, lines: lines.slice(region.startLine) });
    return blocks;
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

/** Drop a trailing run of blank lines (keeps the raw block above the buttons tight). */
function trimTrailingBlank(lines: StyledLine[]): StyledLine[] {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}

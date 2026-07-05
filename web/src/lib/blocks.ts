// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. `raw` mirrors terminal output verbatim; `prompt-select` lifts a Claude single-choice
// dialog into a typed payload the renderer draws as buttons. The discriminated union is shaped so
// further grammars (tool calls, …) are added as new `kind`s without disturbing these.
//
// The pipeline is: parseAnsi(text) → AnsiSegment[] → splitLines(segments) → StyledLine[] →
// buildBlocks(lines, ctx) → Block[]. These functions are PURE (no React) and, together with the
// parser, run once per unique text (memoised by the renderer), so they're off the hot polling path.
// The Claude-only grammars in buildBlocks (prompt-select detection, chrome stripping) live in
// ./grammar; the "which agents get them" decision is the single `hasBlockGrammar` predicate
// (./grammar/agents) — every other agent keeps pure raw output.
//
// Invariant (relied on by find-in-output): joining every RAW block's line text with "\n" reproduces
// the visible mirror text character-for-character. Find operates on global character offsets over
// that string; a prompt-select block is rendered as buttons, so its text is NOT part of that space
// (find covers the raw mirror only).

import type { AnsiSegment } from "./ansi";
import type { PromptModel } from "./grammar/prompt-select";
import { detectPromptSelectRegion } from "./grammar/prompt-select";
import type { WizardModel } from "./grammar/wizard";
import { detectWizardRegion } from "./grammar/wizard";
import { stripChrome } from "./grammar/chrome";
import { hasBlockGrammar } from "./grammar/agents";
import { isBlank, lineText } from "./grammar/markers";

// Re-export the prompt-select + wizard models so consumers (the block components, the race guards)
// have one import site for the AST's typed payloads.
export type { PromptModel, PromptOption, PromptFamily } from "./grammar/prompt-select";
export type { WizardModel, WizardOption, WizardStepChip, WizardAnswer } from "./grammar/wizard";

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
 * A multi-question AskUserQuestion wizard (the stepper dialog) lifted out of the raw mirror and
 * rendered as a native step-by-step form. Like `prompt-select` it REPLACES its region
 * ([stepper header … tail]) in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface WizardBlock {
  kind: "wizard";
  wizard: WizardModel;
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; new members are added purely additively, so a
 * `switch (block.kind)` in the renderer stays exhaustive.
 */
export type Block = RawBlock | PromptSelectBlock | WizardBlock;

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
 * `hasBlockGrammar(ctx.agent)` (Claude today) we detect a tail prompt-select dialog (replacing it
 * with a typed block and keeping everything above it raw) and otherwise strip trailing chrome. Any
 * detection miss falls back to a single raw block — the universal T1 behaviour.
 *
 * Gating is conservative and centralised in {@link hasBlockGrammar}: every OTHER agent (and any
 * unknown/absent one) keeps pure raw output until its own matchers exist, so a non-Claude pane is
 * never mis-parsed. With no `ctx` (or a non-Claude agent) this is the trivial single-raw-block wrap
 * it always was.
 */
export function buildBlocks(lines: StyledLine[], ctx?: { agent?: string }): Block[] {
  // gate: claude-only — every grammar below (wizard, prompt-select, chrome) is Claude Code TUI
  // specific; the "which agents get them" decision is the single hasBlockGrammar predicate, so it
  // can't drift from agent-chat's status-strip gate. Every other agent keeps the pure raw mirror.
  if (!hasBlockGrammar(ctx?.agent)) return [{ kind: "raw", lines }];

  // The wizard runs FIRST: its question phase also carries a select footer, so prompt-select's
  // detector would otherwise have to arbitrate (today it bails on the stepper header — that bail
  // stays as a safety net for a wizard this detector misses).
  const wizardRegion = detectWizardRegion(lines);
  if (wizardRegion) {
    const before = trimTrailingBlank(lines.slice(0, wizardRegion.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "wizard", wizard: wizardRegion.model, lines: lines.slice(wizardRegion.startLine) });
    return blocks;
  }

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

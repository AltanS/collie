// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. `raw` mirrors terminal output verbatim; every other kind lifts a dialog into a typed
// payload the renderer draws as buttons. Those payloads are harness-NEUTRAL contracts, each in its
// own harness/*-model.ts (re-exported below): what ANY adapter promises when it emits that kind, so
// the renderers and the race guard are written against the model, never against a harness's
// internals. The discriminated union is shaped so further grammars (tool calls, …) are added as new
// `kind`s without disturbing these.
//
// The pipeline is: parseAnsi(text) → AnsiSegment[] → splitLines(segments) → StyledLine[] →
// buildBlocks(lines, ctx) → Block[]. splitLines (and the pure helpers below) live here; the
// block-BUILDING step is the harness DISPATCHER (harness/index) routing to a per-agent adapter, so
// this core module has NO dependency on the agent grammars — the edge is one-way, which is what lets
// an adapter import this AST without forming a cycle. These functions are PURE (no React) and,
// together with the parser, run once per unique text (memoised by the renderer), so they're off the
// hot polling path. The Claude grammars themselves (prompt-select detection, chrome stripping) live
// in harness/claude; which agents get them is decided by the adapter registry (harness/registry).
//
// Invariant (relied on by find-in-output): joining every RAW block's line text with "\n" reproduces
// the visible mirror text character-for-character. Find operates on global character offsets over
// that string; a prompt-select block is rendered as buttons, so its text is NOT part of that space
// (find covers the raw mirror only).

import type { AnsiSegment } from "./ansi";
import { PURE_HORIZONTAL_RULE_GLYPH_CLASS } from "./rule-glyphs";
import type { PromptModel } from "./harness/prompt-model";
import type { WizardModel } from "./harness/wizard-model";
import type { PreviewSelectModel } from "./harness/preview-model";
import type { MultiSelectModel } from "./harness/multi-select-model";
import type { MenuModel } from "./harness/menu-model";

// Re-export every dialog model so consumers (the block components, the race guards) have one import
// site for the AST's typed payloads. All five are harness-NEUTRAL contracts (harness/*-model.ts):
// the payload an adapter promises when it emits that block kind, not a Claude internal — the
// dependency points at the shared modules, never at claude/. These are TYPE-ONLY re-exports (erased
// under verbatimModuleSyntax), so they add no runtime edge into harness/ either — the value
// dependency stays one-way (harness → blocks).
export type {
  PromptModel,
  PromptOption,
  PromptFamily,
  PromptFeedbackPurpose,
} from "./harness/prompt-model";
export type { WizardModel, WizardOption, WizardStepChip, WizardAnswer } from "./harness/wizard-model";
export type { PreviewSelectModel, PreviewOption, PreviewNote } from "./harness/preview-model";
export type {
  MultiSelectModel,
  MultiSelectOption,
  MultiSelectEscape,
  MultiPointer,
} from "./harness/multi-select-model";
export type { MenuModel, MenuAction, MenuNav, MenuLeftRight } from "./harness/menu-model";

/** One visual line: the styled segments that make it up, with the line-terminating "\n" removed. */
export interface StyledLine {
  segments: AnsiSegment[];
  /** Keep this known terminal-width border on one visual row when the mirror wraps. */
  noWrap?: true;
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
 * A preview-variant AskUserQuestion (options + preview pane + the per-question note affordance;
 * grammar/NOTES_NOTES.md) lifted out of the raw mirror. Like the other dialog blocks it REPLACES
 * its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface PreviewSelectBlock {
  kind: "preview-select";
  preview: PreviewSelectModel;
  lines: StyledLine[];
}

/**
 * A multi-select AskUserQuestion (the checkbox form + its review screen) lifted out of the raw
 * mirror and rendered as native checkboxes / a confirm screen. Like the other dialog blocks it
 * REPLACES its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface MultiSelectBlock {
  kind: "multi-select";
  multi: MultiSelectModel;
  lines: StyledLine[];
}

/**
 * A GENERIC modal menu (the `/model` picker and its kin) claimed by the last-resort footer grammar —
 * a screen no specific dialog grammar owns, driven by the keys it printed in its own footer. Unlike
 * the dialog blocks above, its region text IS rendered: the grammar understands the footer, not the
 * body, so the body has to stay readable for the buttons under it to mean anything. `lines` is that
 * region — still not part of the find haystack (find runs over raw blocks only).
 */
export interface MenuBlock {
  kind: "menu";
  menu: MenuModel;
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; new members are added purely additively, so a
 * `switch (block.kind)` in the renderer stays exhaustive.
 */
export type Block =
  | RawBlock
  | PromptSelectBlock
  | WizardBlock
  | PreviewSelectBlock
  | MultiSelectBlock
  | MenuBlock;

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
      lines.push(styledLine(current));
      current = [];
      start = idx + 1;
    }
  }

  // The trailing run (after the last "\n", or the whole input if it had none) is the final line —
  // pushed even when empty so a trailing newline yields a terminating blank line.
  lines.push(styledLine(current));
  return lines;
}

// A terminal-width horizontal border is visually useless when browser wrapping turns it into several rows.
// This deliberately accepts only one repeated horizontal rule glyph (apart from terminal padding): labels,
// mixed rows, corners/tables, prose, and ASCII rules keep the mirror's ordinary wrapping.
//
// Twenty stands on two facts of its own, and deliberately cites no other threshold. (1) Nothing in prose,
// markdown or code runs to twenty IDENTICAL rule glyphs, so the classifier cannot fire on real content.
// (2) Below roughly twenty columns a row already fits the narrowest mirror without wrapping, so clipping
// it would buy nothing — the only rows worth clipping are the ones wide enough to wrap.
//
// An earlier revision derived this number from the Claude grammar's own 20-glyph box-border run. That run
// no longer exists: it was a hidden assumption that the pane is at least twenty columns wide, which is
// exactly what stalled the reply guard on a 19-column pane (issue #76), and markers.ts replaced it with a
// display-cell floor. Do not re-couple the two. They classify borders for different consumers with
// opposite failure costs — a false positive there types Enter into the wrong screen, a false positive here
// crops a short rule — so they share the glyph alphabet in rule-glyphs.ts and nothing else.
const MIN_NO_WRAP_BORDER_LENGTH = 20;
const PURE_HORIZONTAL_BORDER = new RegExp(
  `^([${PURE_HORIZONTAL_RULE_GLYPH_CLASS}])\\1{${MIN_NO_WRAP_BORDER_LENGTH - 1},}$`,
);

function styledLine(segments: AnsiSegment[]): StyledLine {
  const text = segments.map((segment) => segment.text).join("");
  return PURE_HORIZONTAL_BORDER.test(text.trim()) ? { segments, noWrap: true } : { segments };
}

// The two generic StyledLine probes. They live HERE, in the core AST module that imports nothing
// from harness/, because they are properties of a StyledLine and of no grammar: the renderer
// (components/ansi-output.tsx) and every harness adapter need them, and a second copy in a
// harness-specific module would make a neutral consumer import a harness. harness/claude/markers
// re-exports them so the Claude grammars keep their one import site.

/** The visible text of a line: its segments' text concatenated (the "\n" separator lives between
 *  lines, so a single line's text never contains one). */
export function lineText(line: StyledLine): string {
  return line.segments.map((s) => s.text).join("");
}

/** True when a line is empty or only whitespace. */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Drop a trailing run of blank lines (keeps the raw block above the buttons tight). Exported for the
 *  harness adapters, whose pipelines tighten the raw region above a lifted dialog with it. */
export function trimTrailingBlank(lines: StyledLine[]): StyledLine[] {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}

// Preview-variant AskUserQuestion detection — the grammar that recognises Claude Code's PREVIEW
// dialog (options in a fixed left column, the pointed option's preview pane on the right, and the
// per-question "Notes:" affordance) at the TAIL of a pane buffer, and lifts it into a
// `PreviewSelectModel` the UI renders natively — including the note add/edit flow.
//
// This variant renders for a question that is !multiSelect AND has ≥1 option with a `preview`
// field, both as a single-question dialog and as a step inside the multi-question wizard. Its
// choreography differs sharply from the standard select/wizard (digits only MOVE the pointer, the
// `n` key opens a note input, Enter inside that input submits/advances) — the verified ground
// truth lives in NOTES_NOTES.md. The T2/T7 grammars never match this layout (the footer sits far
// below the option rows, outside their MAX_FOOTER_GAP), so this detector adds a new surface rather
// than re-arbitrating an existing one.
//
// Everything here is PURE over `StyledLine[]`, fixture-driven (web/src/fixtures/panes/
// claude--*preview*.txt), and never touches a pane or the network.

import type { StyledLine } from "../../blocks";
import { classifyFooter, isBlank, isHorizontalRule, lineText } from "./markers";
import { parseOptionRow } from "./prompt-select";
import { parseStepperLine } from "./wizard";
import type { PreviewNote, PreviewOption, PreviewSelectModel } from "../preview-model";
import type { WizardStepChip } from "../wizard-model";

// The MODEL this grammar produces is a harness-NEUTRAL contract (harness/preview-model.ts) — what any
// adapter promises when it emits a `preview-select` block. Re-exported here so this file stays the
// one import site for everything about the Claude preview grammar.
export type { PreviewNote, PreviewOption, PreviewSelectModel };

/** Detection result for buildBlocks: the model plus the region's first line — the preview region
 *  is [`startLine` … tail], which the renderer replaces with the native block. */
export interface PreviewSelectRegion {
  model: PreviewSelectModel;
  startLine: number;
}

// The footer discriminator: a select-family footer that also advertises the note key. This is the
// single most specific anchor of the variant (no other Claude dialog mentions it).
const NOTES_FOOTER = /\bn to add notes\b/i;
// While the note input is focused the footer additionally offers the external-editor escape.
const NOTE_EDITING_FOOTER = /ctrl\+g to edit\b/i;

// The two literal Notes-line states Claude Code renders (the placeholder's … is U+2026).
const NOTE_HINT = "press n to add notes";
const NOTE_PLACEHOLDER = "Add notes on this design…";

// The unnumbered escape row below the rule ("Chat about this", possibly carrying the pointer).
// Not reachable via Down (it clamps at the last option), so it is tolerated but never up-levelled.
const ESCAPE_ROW = /^❯?\s*Chat about this$/;

/** The chosen-row marker a revisited answered question shows: "1. Grid ✔". */
const CHOSEN_SUFFIX = /\s*✔\s*$/;

// An option row's prefix — indentation, the optional ❯ pointer, the number, the dot and the space
// after it. Its LENGTH is the column the label starts at, which is the anchor a wrapped continuation
// row hangs under. Matched on the UNtrimmed left slice (parseOptionRow trims, losing the column).
const OPTION_LABEL_START = /^\s*(?:❯\s*)?\d+\.\s+/;

/** Leading-space count — how far into the gutter a row's text starts. */
function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

// Bounded windows, same philosophy as the sibling grammars: the Notes line sits within a few lines
// of the footer (rule + escape row between); options+preview sit within a screenful above it.
const NOTES_SCAN_LIMIT = 8;
const OPTION_SCAN_WINDOW = 28;
const QUESTION_SCAN_LIMIT = 12;
const STEPPER_SCAN_LIMIT = 6;

// Lines above the first option folded into the core signature — enough to capture the dialog's
// subject (the prompt/context shown above the question), which is what distinguishes two same-shaped
// dialogs. Mirrors prompt-select's SIGNATURE_LOOKBACK: err wide — a false "changed" is a harmless
// refresh, whereas a false match types a keystroke into a live terminal.
const SIGNATURE_LOOKBACK = 40;

/**
 * Detect a preview-variant dialog at the tail of `lines`. Returns the model + its start line, or
 * null when the tail isn't one. Pure; the caller owns pane access.
 */
export function detectPreviewSelectRegion(lines: StyledLine[]): PreviewSelectRegion | null {
  const texts = lines.map(lineText);

  // 1. Tail anchor: the last non-blank line is a select-family footer that offers `n to add notes`.
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;
  const footer = texts[fi]!;
  if (classifyFooter(footer) !== "select" || !NOTES_FOOTER.test(footer)) return null;
  const editing = NOTE_EDITING_FOOTER.test(footer);

  // 2. The `Notes:` line, a few lines above the footer. Between them only the escape row, the
  //    rule, and blanks may appear — anything else means an unknown layout, so bail to raw.
  let notesIdx = -1;
  for (let i = fi - 1, seen = 0; i >= 0 && seen < NOTES_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    const trimmed = t.trim();
    if (trimmed.startsWith("Notes:")) {
      notesIdx = i;
      break;
    }
    if (isBlank(t) || isHorizontalRule(t) || ESCAPE_ROW.test(trimmed)) continue;
    return null;
  }
  if (notesIdx < 0) return null;

  // The Notes label's column anchors the preview pane: everything left of it on the rows above is
  // option-list territory, everything from it rightward is preview content.
  const noteCol = texts[notesIdx]!.indexOf("Notes:");
  const note = parseNote(texts[notesIdx]!.slice(noteCol + "Notes:".length), editing);

  // 3. Option rows: numbered rows 1..k, matched on the text LEFT of the preview column. Unlike the
  //    full-width grammars, this variant's left column is only ~30 wide, so a longer label WRAPS
  //    onto unnumbered continuation rows beneath it — the numbered rows are therefore NOT
  //    necessarily adjacent. What must hold is that the option list is CONTIGUOUS once those
  //    continuation rows are counted: from the first numbered row down, every line is either the
  //    next numbered row or a continuation of the label above it, until the left column goes blank
  //    (the preview pane continuing alone below a short list).
  const from = Math.max(0, notesIdx - OPTION_SCAN_WINDOW);

  // The LABEL COLUMN — where an option's text begins, past its "❯ 1. " prefix — is what separates a
  // new option from more of the one above it. A wrapped line hangs UNDER its label, so anything
  // starting at or right of that column is label text, and anything left of it is a fresh option.
  // Without this the grammar has no way to tell the two apart, and both directions bite:
  //   - a label ending "…and 3. Backfill later" would wrap to a row parsing as a phantom option 3;
  //   - in a layout where `Notes:` and the preview pane DON'T share a column, preview content would
  //     sit in the left slice and get folded into the last option's label as box-drawing garbage.
  let labelCol = -1;
  for (let i = from; i < notesIdx; i++) {
    const left = texts[i]!.slice(0, noteCol);
    const m = OPTION_LABEL_START.exec(left);
    // Must be a REAL option row, not merely something shaped like a number and a dot: a bare "12."
    // with no label matches the prefix but carries no option, and would shift the very column that
    // decides what counts as a new option.
    if (m && parseOptionRow(left)) {
      labelCol = m[0]!.length;
      break;
    }
  }
  if (labelCol < 0) return null;

  const rows: { index: number; n: number; label: string; pointed: boolean }[] = [];
  for (let i = from; i < notesIdx; i++) {
    const left = texts[i]!.slice(0, noteCol);
    if (indentOf(left) >= labelCol) continue; // a number inside a wrapped label, not an option
    const parsed = parseOptionRow(left);
    if (parsed) rows.push({ index: i, pointed: /^\s*❯/.test(left), ...parsed });
  }
  if (rows.length < 2) return null;
  if (rows.some((r, k) => r.n !== k + 1)) return null;
  // Past 9 the digit is two keys ("10"), which Herdr's send_keys rejects — so the button would render
  // and then fail on tap. Bail to the raw mirror + keys pad instead, as prompt-select does.
  if (rows.length > 9) return null;
  const firstOpt = rows[0]!.index;

  // Walk the list, folding each wrapped row into its option's label. `lastOpt` ends up on the last
  // line still owned by the list (a continuation row when the FINAL label wraps) — which is what
  // the core signature must span, so a wrapped tail can't fall out of the dialog's identity.
  //
  // `chosen` is tracked per PIECE rather than read off the joined label: a revisited question paints
  // its ✔ at the end of the row it marks, which for a wrapped label is the numbered row — the middle
  // of the joined string, where an end-anchored test would miss it and leave the tick in the text.
  const labels = rows.map((r) => r.label.replace(CHOSEN_SUFFIX, ""));
  const chosen = rows.map((r) => CHOSEN_SUFFIX.test(r.label));
  let cursor = 0;
  let lastOpt = firstOpt;
  let scan = firstOpt;
  for (; scan < notesIdx; scan++) {
    const left = texts[scan]!.slice(0, noteCol);
    if (isBlank(left)) break;
    if (cursor + 1 < rows.length && rows[cursor + 1]!.index === scan) {
      cursor++;
    } else if (scan !== firstOpt) {
      // Right of the label column this isn't label text — it's a layout we don't know. Fold only
      // what hangs under the label; bail on anything else rather than put it on a button.
      if (indentOf(left) > labelCol) return null;
      const piece = left.trim();
      if (CHOSEN_SUFFIX.test(piece)) chosen[cursor] = true;
      labels[cursor] += ` ${piece.replace(CHOSEN_SUFFIX, "")}`;
    }
    lastOpt = scan;
  }
  // Every numbered row must have been reached before the left column went blank — a stray "N." row
  // below the gap is a different layout, not a wrapped label.
  if (cursor !== rows.length - 1) return null;

  // Below the list and above the Notes line only preview continuation (blank left column) may
  // appear — a non-blank left cell there is a layout we don't know.
  for (; scan < notesIdx; scan++) {
    if (!isBlank(texts[scan]!.slice(0, noteCol))) return null;
  }

  // 4. The preview pane: the right column of the region's lines, verbatim (borders included).
  const preview: string[] = [];
  for (let i = firstOpt; i < notesIdx; i++) preview.push(texts[i]!.slice(noteCol).trimEnd());
  while (preview.length > 0 && preview[0]!.length === 0) preview.shift();
  while (preview.length > 0 && preview[preview.length - 1]!.length === 0) preview.pop();

  // 5. The question above the options (every dialog's prompt carries a "?"), bounded, stopping at
  //    a rule so the search can't cross out of the dialog.
  let questionIdx = -1;
  for (let i = firstOpt - 1, seen = 0; i >= 0 && seen < QUESTION_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    if (isHorizontalRule(t)) break;
    if (t.includes("?")) {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 0) return null;

  // 6. A wizard stepper above the question makes this a wizard step (Left/Right navigation applies
  //    and the question joins the block region, as in the standard wizard grammar). A lone chip
  //    line (" ☐ Design") never parses as a stepper, so single-question dialogs get steps: null.
  let steps: WizardStepChip[] | null = null;
  let startLine = firstOpt;
  let question = texts[questionIdx]!.trim();
  for (let i = questionIdx - 1, seen = 0; i >= 0 && seen < STEPPER_SCAN_LIMIT; i--, seen++) {
    if (isHorizontalRule(texts[i]!)) break;
    const stepper = parseStepperLine(lines[i]!);
    if (stepper) {
      steps = stepper.chips;
      startLine = i;
      // Long questions wrap; in the wizard form every non-blank line between the stepper and the
      // options is the question (mirrors wizard.ts).
      const parts: string[] = [];
      for (let j = i + 1; j < firstOpt; j++) {
        if (!isBlank(texts[j]!)) parts.push(texts[j]!.trim());
      }
      if (parts.length > 0) question = parts.join(" ");
      break;
    }
  }

  const options: PreviewOption[] = rows.map((r, k) => ({
    label: labels[k]!.trim(),
    n: r.n,
    pointed: r.pointed,
    chosen: chosen[k]!,
  }));

  return {
    model: {
      question,
      options,
      preview,
      note,
      steps,
      regionSignature: texts
        .slice(Math.max(0, firstOpt - SIGNATURE_LOOKBACK), fi + 1)
        .join("\n"),
      coreSignature: computeCoreSignature(texts, firstOpt, lastOpt, noteCol),
    },
    startLine,
  };
}

/**
 * The dialog's pointer/note-independent CORE SIGNATURE (see `PreviewSelectModel.coreSignature`): the
 * head lines [firstOpt − LOOKBACK … firstOpt) — the stepper/chip header, the question, and any
 * subject/preamble above the options — joined with each option row's LEFT column (`slice(0, noteCol)`,
 * `❯` normalised to a space so our own pointer move doesn't perturb it). Pure of the buffer's absolute
 * offset, so the frozen model and a fresh re-derivation of the SAME dialog produce byte-equal strings.
 */
function computeCoreSignature(
  texts: string[],
  firstOpt: number,
  lastOpt: number,
  noteCol: number,
): string {
  const head = texts.slice(Math.max(0, firstOpt - SIGNATURE_LOOKBACK), firstOpt);
  const left: string[] = [];
  for (let i = firstOpt; i <= lastOpt; i++) {
    left.push(texts[i]!.slice(0, noteCol).replace(/❯/g, " "));
  }
  return [...head, ...left].join("\n");
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectPreviewSelect(lines: StyledLine[]): PreviewSelectModel | null {
  return detectPreviewSelectRegion(lines)?.model ?? null;
}

/** Parse the text after "Notes:" into the note's state + text (NOTES_NOTES.md table). */
function parseNote(rest: string, editing: boolean): PreviewNote {
  const text = rest.trim();
  if (text === NOTE_HINT && !editing) return { state: "none", text: "" };
  if (text === NOTE_PLACEHOLDER && editing) return { state: "editing", text: "" };
  return { state: editing ? "editing" : "attached", text };
}

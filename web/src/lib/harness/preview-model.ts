// The PREVIEW-SELECT MODEL — the harness-NEUTRAL payload of a `preview-select` Block.
//
// A single-choice dialog whose pointed option renders a preview pane, plus the per-question note
// affordance. Its choreography is multi-step (a digit only MOVES the pointer; `n` opens a note
// input), which is why it carries TWO signatures: `regionSignature` binds a write to the literal
// text on screen, `coreSignature` is the pointer/note-independent identity the guard compares across
// the whole choreography. Any adapter can produce one; the renderer
// (components/preview-select-block.tsx) and the race guard (lib/preview-action.ts →
// lib/dialog-guard.ts) are written against these types alone.
//
// Claude's reference detector is harness/claude/preview-select.ts; the verified ground truth is
// grammar/NOTES_NOTES.md. Imports nothing but its sibling model, so `lib/blocks.ts` can re-export it
// without a cycle. The identity comparators live in dialog-contract.ts.

import type { WizardStepChip } from "./wizard-model";

/** The per-question note, parsed off the `Notes:` line + the footer's focus marker. */
export interface PreviewNote {
  /**
   * `none`: the dim "press n to add notes" hint — no note attached.
   * `editing`: the TUI's note input is FOCUSED (footer shows "ctrl+g to edit …") — keystrokes go
   * into the input, so Collie must not drive the dialog until it blurs.
   * `attached`: a committed note is on the question (input blurred).
   */
  state: "none" | "editing" | "attached";
  /** The visible note text ("" for none / the empty placeholder). The TUI windows the display at
   *  ~60 columns, so a long note may be a truncated readback. */
  text: string;
}

/** One selectable option of the preview dialog. */
export interface PreviewOption {
  /** The visible label (a React text node downstream — the XSS boundary is unchanged). */
  label: string;
  /** The option's digit. In this variant the digit only MOVES the pointer; selection is a separate
   *  Enter once the pointer is verified (see preview-action.ts — never send both in one call). */
  n: number;
  /** This row carries the `❯` pointer — the row Enter would select, and the preview pane's owner. */
  pointed: boolean;
  /** Trailing ` ✔` on a revisited, already-answered wizard question's chosen row. */
  chosen: boolean;
}

/** A detected preview-variant AskUserQuestion (single-question or one wizard step). */
export interface PreviewSelectModel {
  question: string;
  options: PreviewOption[];
  /** The right-hand preview pane of the POINTED option, as plain text lines (borders included). */
  preview: string[];
  note: PreviewNote;
  /** The wizard stepper chips when this question is a step of a multi-question dialog; null for a
   *  single-question dialog. Navigation uses the same Left/Right keys as the standard wizard. */
  steps: WizardStepChip[] | null;
  /**
   * The literal, contiguous dialog region from the bounded lookback through the footer. The bridge
   * must find this text in its fresh pane.read before writing. Unlike `coreSignature`, this includes
   * the pointer and note state, so it changes during the choreography and binds only the first write
   * after the client guard. `coreSignature` remains the pointer- and note-independent identity used
   * by client comparisons across the full choreography.
   */
  regionSignature: string;
  /**
   * A pointer- and note-INDEPENDENT byte-signature of the dialog's identity, computed at detection
   * time: the head lines above the options (the stepper/chip header + question + any subject/preamble
   * within a bounded lookback, mirroring prompt-select's SIGNATURE_LOOKBACK) joined with the LEFT
   * COLUMN of every option row (with the ❯ pointer normalised to a space). It deliberately EXCLUDES
   * the preview pane (which follows the pointer), the Notes line, and the footer (which carry the
   * note state) — so it stays byte-stable across the whole option-select and note choreography, yet a
   * DIFFERENT dialog rendered in the same shape (different subject / question / labels) breaks it.
   * The race guard compares it so no irreversible key is ever sent to a same-shaped successor the
   * user never saw. Herdr's `revision` is a stub, so this content signature is the load-bearing
   * freshness check — it MUST be non-empty and MUST change when the region's text changes.
   */
  coreSignature: string;
}

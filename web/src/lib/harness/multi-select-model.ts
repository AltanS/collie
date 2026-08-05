// The MULTI-SELECT MODEL — the harness-NEUTRAL payload of a `multi-select` Block.
//
// The checkbox form of a question dialog: numbered rows a digit TOGGLES, an advance row the pointer
// must be walked onto, and (optionally) a review screen. Like the preview model it carries TWO
// signatures: `signature` normalises the pointer AND the checkbox glyphs out — it is the identity the
// guard compares while the Submit macro deliberately moves the pointer — and `regionSignature` is the
// literal text a write binds to. Any adapter can produce one; the renderer
// (components/multi-select-block.tsx) and the race guard (lib/multi-select-action.ts →
// lib/dialog-guard.ts) are written against these types alone.
//
// Claude's reference detector is harness/claude/multi-select.ts. Imports nothing but its sibling
// model, so `lib/blocks.ts` can re-export it without a cycle. The identity comparators live in
// dialog-contract.ts.

import type { WizardStepChip } from "./wizard-model";

/** One checkable option of the current checkbox question. */
export interface MultiSelectOption {
  /** The option's digit — pressing it TOGGLES this row (pointer-independent). */
  n: number;
  /** The visible label with the `[ ]`/`[✔]` prefix stripped (a React text node downstream). */
  label: string;
  /** Secondary descriptive line(s), joined with spaces. Absent when none. */
  description?: string;
  /** Lifted from the checkbox glyph: `[✔]`/`[x]`/`[✓]` = checked, `[ ]` = unchecked. The terminal is
   *  the single source of truth (a digit is an XOR — the UI never holds its own checked state). */
  checked: boolean;
}

/** The unnumbered-in-spirit "Chat about this" escape (it carries a digit, but ABORTS the tool). */
export interface MultiSelectEscape {
  n: number;
  label: string;
}

/** Which KIND of row the `❯` pointer sits on — the advance macro drives it to `advance` before Enter.
 *  Parsed SEPARATELY from the signature (which normalises the pointer out), so the macro's own
 *  Down/Up moves don't perturb the race-guard identity. */
export type MultiPointer = "advance" | "chat" | "option" | "other" | null;

/**
 * The detected multi-select dialog, a union on `phase`:
 *  - `checkbox`: the question + its checkable options, the "Chat about this" escape, and where the
 *    pointer sits. A digit toggles; the advance row is reached by the closed-loop macro (see
 *    lib/multi-select-action.ts).
 *  - `review`: the confirm screen — submit = key `1`, cancel = key `2` (constants, off the model).
 *
 * `signature` is a byte-signature of the on-screen region (stepper → tail) with BOTH the `❯` pointer
 * AND each `[✔]`/`[ ]` checkbox glyph normalised out: it captures the subject + labels only, so the
 * Submit macro's pointer moves and a checkbox flip don't spuriously fail the race guard. The transient
 * state (pointer, checked) is compared separately by the comparators via the options[]. Herdr's
 * `revision` is a stub, so this content signature is the load-bearing freshness check — it MUST be
 * non-empty and MUST change when the region's text changes.
 */
export type MultiSelectModel =
  | {
      phase: "checkbox";
      question: string;
      options: MultiSelectOption[];
      escape: MultiSelectEscape | null;
      pointer: MultiPointer;
      /**
       * The wizard stepper's chips when this checkbox question is one STEP of a multi-question
       * dialog; null when it's a standalone single-question multiSelect. Same distinction (and same
       * Left/Right navigation) as `PreviewSelectModel.steps`.
       */
      steps: WizardStepChip[] | null;
      /**
       * The advance row's literal label — `Submit` on the last question, `Next` on every earlier one.
       * Captured rather than assumed so the button says what the terminal says.
       */
      advanceLabel: string;
      signature: string;
      /**
       * Literal contiguous text over the same stepper-to-last-menu-row span as `signature`. It ends
       * before the footer because pointer moves change that footer during the macro. The bridge must
       * find this text in its fresh pane.read, while `signature` remains the pointer- and
       * checkbox-independent identity used by client comparisons.
       */
      regionSignature: string;
    }
  | {
      phase: "review";
      incomplete: boolean;
      signature: string;
      /**
       * Literal contiguous text over the same stepper-to-tail span as `signature`. The checkbox
       * phase uses the same rule and stops at its last menu row rather than its mutable footer. The
       * bridge must find this text in its fresh pane.read, while `signature` remains the pointer- and
       * checkbox-independent identity used by client comparisons.
       */
      regionSignature: string;
    };

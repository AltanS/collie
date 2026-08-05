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
// model, so `lib/blocks.ts` can re-export it without a cycle. The identity comparators at the bottom
// are part of the same contract (harness/dialog-contract.ts wires kind → comparator).

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

/** Are these the same wizard step? The `signature` normalises `☒/☑ → ☐` across the WHOLE chip line
 *  (it has to: the current question's chip flips on the first tick), which also erases which step you
 *  are on. Two questions of one wizard sharing a question text and option labels would otherwise be
 *  byte-identical to the guard, and a tap meant for the first would land on the second. Compared
 *  explicitly here, exactly as the preview comparator does. */
function sameSteps(a: MultiSelectModel, b: MultiSelectModel): boolean {
  if (a.phase !== "checkbox" || b.phase !== "checkbox") return true;
  if (a.steps === null || b.steps === null) return a.steps === b.steps;
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every(
    (s, i) =>
      s.label === b.steps![i]!.label &&
      s.answered === b.steps![i]!.answered &&
      s.current === b.steps![i]!.current,
  );
}

/**
 * Whether two derivations are the same on-screen state — the entry-guard comparison. The
 * pointer/checkbox-independent core signature is decisive (a re-rendered dialog / different subject
 * changes it); question + options (labels AND `checked`) re-introduce the checkbox state the
 * signature normalises out, so the FULL visible state participates. The pointer is deliberately NOT
 * compared — it is transient (the Submit macro moves it) and the signature already strips it.
 *
 * Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 * adapter produced the block through exactly these functions.
 */
export function multiSelectEquals(a: MultiSelectModel, b: MultiSelectModel): boolean {
  if (a.phase !== b.phase) return false;
  if (a.signature !== b.signature) return false;
  if (a.phase === "checkbox" && b.phase === "checkbox") {
    return (
      sameSteps(a, b) &&
      a.advanceLabel === b.advanceLabel &&
      a.question === b.question &&
      a.options.length === b.options.length &&
      a.options.every(
        (o, i) => o.label === b.options[i]!.label && o.checked === b.options[i]!.checked,
      )
    );
  }
  if (a.phase === "review" && b.phase === "review") return a.incomplete === b.incomplete;
  return false;
}

/**
 * The dialog's identity for the mid-flight polls (the Submit walk) — independent of the transient `❯`
 * pointer, but NOT of the checkbox state. The core signature (pointer/checkbox-normalised) plus
 * question + option labels AND `checked`: a same-shaped successor (different subject) breaks the
 * signature; the macro's own Down/Up moves only shift the pointer (normalised out of both), so the
 * walk stays on the same dialog — but a box that flipped underfoot IS drift. The Submit walk never
 * toggles a box (it sends only Down/Up/Enter), so folding `checked` in costs nothing on the happy path
 * yet aborts the instant an external actor (a second device) flips a box mid-walk, rather than walking
 * on to Submit and shipping a set the user never saw. Only genuine drift (or the dialog vanishing)
 * resolves to "drifted".
 */
export function multiSelectIdentity(a: MultiSelectModel, b: MultiSelectModel): boolean {
  if (a.phase !== b.phase) return false;
  if (a.signature !== b.signature) return false;
  if (a.phase === "checkbox" && b.phase === "checkbox") {
    return (
      sameSteps(a, b) &&
      a.advanceLabel === b.advanceLabel &&
      a.question === b.question &&
      a.options.length === b.options.length &&
      a.options.every(
        (o, i) => o.label === b.options[i]!.label && o.checked === b.options[i]!.checked,
      )
    );
  }
  return true; // review: the signature is the whole identity
}

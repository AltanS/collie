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
// models, so `lib/blocks.ts` can re-export it without a cycle. The identity comparators at the bottom
// are part of the same contract (harness/dialog-contract.ts wires kind → comparator).

import { sameKeys, sameOptionalKeys } from "./prompt-model";
import type { WizardAnswer, WizardStepChip } from "./wizard-model";

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
 * How a tap turns into keystrokes on this dialog — the one thing about multi-select choreography
 * that differs between harnesses, carried as data so the core macros (lib/multi-select-action.ts)
 * stay harness-neutral:
 *  - `"digit"`: the row's digit performs the action — digit N toggles option N (pointer-independent),
 *    and review confirms on `1` / cancels on `2` (constants, off the model). Claude.
 *  - `"pointer"`: the pointer must be walked onto the row and Enter pressed — a digit merely MOVES
 *    the pointer (verified target row first), and review swallows digits entirely. Muse.
 *  - `"walkSpace"`: Up/Down arrows walk the pointer onto row n directly, verified on a fresh read,
 *    then Space toggles row n (the walk, verify, confirm of ADR 0080). pi.
 *
 * Compared by both comparators below: a dialog that changed modes mid-flight is a different dialog.
 * The mode is load-bearing for SAFETY, not just UX — sending a digit where Enter toggles (or vice
 * versa) answers a different question than the button advertised — so detectors set it from a probed
 * recipe, never by default. The TOGGLE has no third value: a checkbox whose recipe is neither stays
 * raw. The REVIEW has one more, `"keys"` (see {@link MultiSelectReviewSubmit}): a review screen with
 * no action rows at all, where submit and cancel are fixed keys the harness declares on the model
 * (opencode's `Confirm` tab: `Enter` submits, `Escape` dismisses).
 */
export type MultiSelectChoreography = "digit" | "pointer" | "walkSpace";

/**
 * How the review screen submits and cancels, a union on `submit`. The two row-driven recipes of
 * {@link MultiSelectChoreography} carry no keys of their own (the digits are constants, the pointer
 * walk ends on Enter). `"keys"` carries BOTH plans, required, because a review screen without action
 * rows has nothing else the macros could aim at; each plan is sent once as one guarded write. The
 * type forbids a key plan on the row-driven recipes, so a model can never say two things at once.
 * The review legs of both comparators compare `submit` and, in `"keys"` mode, both plans exactly.
 */
export type MultiSelectReviewSubmit =
  | { submit: MultiSelectChoreography; submitKeys?: never; cancelKeys?: never }
  | { submit: "keys"; submitKeys: string[]; cancelKeys: string[] };

/**
 * The detected multi-select dialog, a union on `phase`:
 *  - `checkbox`: the question + its checkable options, the "Chat about this" escape, and where the
 *    pointer sits. Toggle follows `toggle` (digit, or digit-jump + verified Enter); the advance row
 *    is reached by the closed-loop macro either way (see lib/multi-select-action.ts), unless the
 *    dialog has no advance row and declares `advanceKeys` instead.
 *  - `review`: the confirm screen — submit/cancel follow `submit` (constant digits, a verified
 *    pointer walk + a freshly-bound Enter, or the declared `submitKeys`/`cancelKeys`).
 *
 * `signature` is a byte-signature of the on-screen region (stepper → tail) with BOTH the pointer
 * AND each checkbox glyph normalised out: it captures the subject + labels only, so the Submit
 * macro's pointer moves and a checkbox flip don't spuriously fail the race guard. The transient
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
       * The numbered row the pointer sits on — the option `n` when it points at one, null when it
       * points at the advance row, sits elsewhere, or no pointer glyph is visible (torn frame).
       * The pointer-mode toggle macro digit-jumps then verifies THIS before pressing Enter; digit
       * mode never reads it (its detector reports null). Transient like `pointer`: compared by NO
       * comparator — the macros check it directly on a fresh re-derivation instead.
       */
      pointerRow: number | null;
      /**
       * The wizard stepper's chips when this checkbox question is one STEP of a multi-question
       * dialog; null when it's a standalone single-question multiSelect. Same distinction (and same
       * Left/Right navigation) as `PreviewSelectModel.steps`.
       */
      steps: WizardStepChip[] | null;
      /**
       * The advance row's literal label — `Submit` on the last question, `Next` on every earlier one.
       * Captured rather than assumed so the button says what the terminal says. The ONE exception: a
       * harness whose advance row carries live checkbox STATE (Muse's `Submit answer (N checked)`
       * count) reports the stable stem — the comparators compare this label, and state belongs in
       * `options[]`, not smuggled into a label comparison that would break macro identity on flips.
       */
      advanceLabel: string;
      /**
       * The advance as a fixed key plan, for a dialog that has NO advance row (opencode's lone
       * multi-select list reaches its `Confirm` tab with `Tab`). When present, the advance is this
       * plan sent ONCE as one guarded write bound to the entry region, and the pointer walk never
       * runs; `advanceLabel` still names where the keys go. Absent ⇒ the walk onto the advance row.
       * Compared exactly by both comparators: like `toggle`, the plan is load-bearing for SAFETY,
       * because a different key on the same screen lands somewhere the button did not advertise.
       */
      advanceKeys?: string[];
      /**
       * Opt-in: the advance needs at least one checked option AND the pointer on an option row (not
       * `other`). Otherwise the card disables its advance button and multi-select-action refuses the
       * advance.
       */
      advanceNeedsChecked?: boolean;
      /**
       * The toggle recipe (see {@link MultiSelectChoreography}). Compared by both comparators.
       */
      toggle: MultiSelectChoreography;
      signature: string;
      /**
       * Literal contiguous text over the same span as `signature`. Two constraints pick that span,
       * and they cut in opposite directions: the span must be IDENTITY-STABLE across macro steps
       * (nothing the macros mutate — pointer, checkbox glyphs, counts, footers that react to the
       * pointer), and it must END inside the bridge's tail window (`verifyExpectedPrompt` only
       * binds a match ending within 6 non-blank rows of the read — conformance pins this per
       * dialog). Claude ends at its last menu row because its footer mutates mid-macro; Muse runs
       * through its static footer because ending at Submit strands 6 rows below the match and 409s
       * every first write. The bridge must find this text in its fresh pane.read, while
       * `signature` remains the pointer- and checkbox-independent identity used by client
       * comparisons.
       */
      regionSignature: string;
    }
  | ({
      phase: "review";
      incomplete: boolean;
      /**
       * Which action row the pointer sits on — `null` when no pointer glyph is visible (torn
       * frame), `"other"` when it sits on a non-action row. The pointer-mode review macro walks
       * THIS to its target and verifies before Enter; digit and keys mode never read it (their
       * detectors report null). Transient: compared by NO comparator.
       */
      pointer: "submit" | "cancel" | "other" | null;
      /**
       * The answers the review screen echoes (`Header: a, b, typed`, one row per question), shown
       * on the card so the operator submits what they can see. Absent when the harness prints no
       * such rows. Compared by both comparators: the review has no mid-flight macro in `keys` mode,
       * and a changed answer is a different screen.
       */
      answers?: WizardAnswer[];
      /**
       * A way back to the checkbox screen as ONE guarded write (opencode: `Left` from `Confirm`).
       * Absent ⇒ the card offers no way back. Compared exactly by both comparators, like every key
       * plan on this model.
       */
      backKeys?: string[];
      /**
       * The terminal's own words for the cancel row, shown verbatim on its button; absent ⇒ the
       * translated "Cancel". Muse's cancel row is `Interrupt turn`, which ends the whole turn, and
       * a button that said "Cancel" would promise less than the key does. Static per adapter, so
       * no comparator reads it.
       */
      cancelLabel?: string;
      signature: string;
      /**
       * Literal contiguous text over the same stepper-to-tail span as `signature` — lead through
       * the last action row, which sits directly above the tail chrome on every harness so far. The
       * bridge must find this text in its fresh pane.read, while `signature` remains the pointer-
       * independent identity used by client comparisons.
       */
      regionSignature: string;
    } & MultiSelectReviewSubmit);

/** The review phase on its own, for the comparator legs and the renderer. */
type MultiSelectReview = Extract<MultiSelectModel, { phase: "review" }>;

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

/** The review screen's recipe and what it shows: the submit mode, every declared key plan exactly
 *  (a plan that changed would send a different key than the button advertised), and the echoed
 *  answers. Shared by the review legs of both comparators. */
function sameReview(a: MultiSelectReview, b: MultiSelectReview): boolean {
  if (a.submit === "keys" || b.submit === "keys") {
    if (a.submit !== "keys" || b.submit !== "keys") return false;
    if (!sameKeys(a.submitKeys, b.submitKeys) || !sameKeys(a.cancelKeys, b.cancelKeys)) return false;
  } else if (a.submit !== b.submit) {
    return false;
  }
  return sameOptionalKeys(a.backKeys, b.backKeys) && sameAnswers(a.answers, b.answers);
}

function sameAnswers(a: WizardAnswer[] | undefined, b: WizardAnswer[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((qa, i) => qa.question === b[i]!.question && qa.answer === b[i]!.answer)
  );
}

/**
 * Whether two derivations are the same on-screen state — the entry-guard comparison. The
 * pointer/checkbox-independent core signature is decisive (a re-rendered dialog / different subject
 * changes it); question + options (labels AND `checked`) re-introduce the checkbox state the
 * signature normalises out, so the FULL visible state participates. The pointer is deliberately NOT
 * compared — it is transient (the Submit macro moves it) and the signature already strips it. Every
 * key plan the model declares (`advanceKeys`, the review's `submitKeys`/`cancelKeys`/`backKeys`)
 * participates exactly, in this comparator and in {@link multiSelectIdentity}.
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
      sameOptionalKeys(a.advanceKeys, b.advanceKeys) &&
      (a.advanceNeedsChecked ?? false) === (b.advanceNeedsChecked ?? false) &&
      a.question === b.question &&
      a.toggle === b.toggle &&
      a.options.length === b.options.length &&
      a.options.every(
        (o, i) => o.label === b.options[i]!.label && o.checked === b.options[i]!.checked,
      )
    );
  }
  if (a.phase === "review" && b.phase === "review")
    return a.incomplete === b.incomplete && sameReview(a, b);
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
      sameOptionalKeys(a.advanceKeys, b.advanceKeys) &&
      (a.advanceNeedsChecked ?? false) === (b.advanceNeedsChecked ?? false) &&
      a.question === b.question &&
      a.toggle === b.toggle &&
      a.options.length === b.options.length &&
      a.options.every(
        (o, i) => o.label === b.options[i]!.label && o.checked === b.options[i]!.checked,
      )
    );
  }
  if (a.phase === "review" && b.phase === "review") return sameReview(a, b);
  return false;
}

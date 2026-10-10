// The PROMPT-SELECT MODEL — the harness-NEUTRAL payload of a `prompt-select` Block.
//
// A single-choice dialog: a question, a list of options, and the family whose verified keystroke
// recipe each option's `keys` already encodes. Any adapter can produce one; the renderer
// (components/prompt-select-block.tsx) and the race guard (lib/prompt-action.ts → lib/dialog-guard.ts)
// are written against these types alone, never against a harness's internals.
//
// Types + the pure IDENTITY COMPARATOR, no detection and no harness conventions. Claude's reference
// detector is harness/claude/prompt-select.ts. This module imports nothing at runtime, so
// `lib/blocks.ts` can re-export it without a cycle. Its one import is the TYPE of a styled segment
// from `lib/ansi.ts`, a leaf that imports neither blocks.ts nor harness/, so not even a type-level
// cycle exists: {@link PromptSubjectLine} spells a StyledLine's shape over it instead of importing
// StyledLine from blocks.ts.

import type { AnsiSegment } from "../ansi";

/**
 * One row of a dialog's SUBJECT ({@link PromptModel.subject}), styles kept. Structurally a
 * `StyledLine` (lib/blocks.ts), which is assignable to it and from it, spelled here so this module
 * need not import blocks.ts, which re-exports it.
 */
export interface PromptSubjectLine {
  segments: AnsiSegment[];
}

/** The single-choice dialog families a harness can report, discriminated by its footer hint bar.
 *  The family is what pins the keystroke recipe (digit-then-Enter vs digit alone), so it is part of
 *  the neutral contract even though today only Claude's footers are classified. */
export type PromptFamily = "select" | "permission" | "trust" | "plan";

/** One selectable option, up-levelled into a tappable button. */
export interface PromptOption {
  /** The visible option label (rendered as a React text node — the XSS boundary is unchanged). */
  label: string;
  /** Secondary descriptive line(s) the dialog supplies, joined with spaces. Absent when none. */
  description?: string;
  /**
   * The keys to send (in order) to choose this option, per the dialog family's verified recipe:
   * `select` needs the digit THEN `Enter` ("Enter to select"); `permission`/`trust`/`plan` confirm
   * on the digit ALONE (a trailing Enter there would leak into whatever renders next).
   * When an option carries its own `keys`, those win over the family's default choreography —
   * Codex question cards submit on the digit alone even though their family is `select`.
   */
  keys: string[];
  /**
   * What the option's badge shows when `keys[0]` is not the identifying key — e.g. Grok's parked
   * ask card sends `["Tab", "2"]` (Tab re-enters the card first) but the row is still "option 2".
   * Absent when `keys[0]` already is the badge.
   */
  keyLabel?: string;
}

/**
 * Why the inline free-text row exists. Absent means Claude's plan-approval input — the only
 * purpose `submitPromptFeedback` will type into.
 *
 *   - `plan-change` — Claude's "Tell Claude what to change": the digit focuses the field, typing
 *     fills it, Enter denies the plan and hands the agent the text (PLAN_FEEDBACK_NOTES.md).
 *   - `free-text` — another harness's custom-answer row (Grok's `z`). Parsed so a focused row can
 *     lock the option buttons; Collie does not type into it. The Claude plan-feedback send path
 *     is the wrong recipe (different key, different Enter, unmeasured caret/wrap).
 */
export type PromptFeedbackPurpose = "plan-change" | "free-text";

/**
 * The dialog's inline free-text INPUT row, when it has one (Claude's plan approval: "Tell Claude
 * what to change"; Grok's ask card: `z`). It is never an option — it is answered by typing, and
 * its key only moves focus onto it. Modelled rather than merely dropped because both of its
 * variables change what every OTHER row's digit does, and the phone has to see that:
 *
 *   - `focused` — while `❯` sits on the row the field owns the keyboard, and the dialog routes every
 *     digit into it AS TEXT instead of answering. No button on this dialog can fire.
 *   - `text` — what the box holds. Empty (the row shows its placeholder) is the only state Collie
 *     will type into on a `plan-change` row: re-entering a non-empty field puts the caret at
 *     position 0, so our text would be PREPENDED to a sentence someone else is mid-way through writing.
 *
 * Claude's four states were measured a keystroke at a time against Claude Code 2.1.228 — see
 * `web/src/lib/grammar/PLAN_FEEDBACK_NOTES.md`, which is the ground truth for `plan-change`.
 */
export interface PromptFeedback {
  /** The key that focuses the field. On Claude this is a digit (INSTALL-DEPENDENT —
   *  `showClearContextOnPlanAccept` adds a row, making it 4 instead of 3). On Grok it is `z`.
   *  Nothing may assume a fixed value. */
  key: string;
  /** `❯` is on this row: the field has the keyboard and every digit is swallowed as a character. */
  focused: boolean;
  /** What the box holds; `""` while it shows its placeholder. See the caret hazard above. */
  text: string;
  /** Absent = `plan-change` (Claude). Set explicitly when the row is not that input. */
  purpose?: PromptFeedbackPurpose;
}

/** A recognised single-choice dialog: the question, its selectable options, and the family. */
export interface PromptModel {
  question: string;
  options: PromptOption[];
  family: PromptFamily;
  /**
   * The card's own caption, when the dialog names itself with a title the family's generic caption
   * ("Choose an option", …) would otherwise cover — e.g. `/resume`'s "Resume session" or "Resume
   * session (1 of 50)" (ADR 0058). Absent means the renderer keeps the family caption every other
   * `select`/`permission`/`trust`/`plan` card already shows; this never changes their behaviour.
   */
  caption?: string;
  /** The dialog's inline free-text input row, when it has one. Absent on dialogs without one. */
  feedback?: PromptFeedback;
  /**
   * What the dialog asks about: the rows it paints between its own top edge and its question, with
   * the dialog's chrome removed (its indent, a `│` gutter, dashed rules, a stock tip) and the
   * terminal's styles kept. A permission dialog's header (`Bash command · from the … agent`), its
   * description, the command or diff, and any warning. Leading and trailing blank rows are trimmed
   * and a run of blank rows is one. No row cap: the renderer bounds the height.
   *
   * Absent when the grammar found no top edge in reach, or nothing between the edge and the
   * question. Display only: it plays no part in identity, `signature` already covers these rows.
   * The card used to leave the subject in the raw mirror above it, which the docked card (ADR 0059)
   * and the journal-based Chat view no longer show.
   */
  subject?: PromptSubjectLine[];
  /**
   * The grammar's declared FACT that its pointed list clamps at both ends: Up on the first row and
   * Down on the last row leave the pointer where it is. The action layer then commits an edge row
   * with a sticky arrow (`["Up","Enter"]` on the first, `["Down","Enter"]` on the last, see
   * {@link commitKeysFor}), so a desk arrow that lands between the bridge's re-read and its send
   * cannot move the commit off the edge row (ADR 0080 point 6).
   *
   * Set ONLY by a grammar whose source or capture proves the clamp, never guessed, and never on a
   * list that wraps (omp's `/switch` picker wraps; an extra arrow there would commit the opposite
   * edge). The edges are the first and last ROW OF THE LIST AS THE ARROWS SEE IT, which is the
   * first and last option whose plan is walk-class ({@link splitWalk}); options with any other plan
   * (a `Cancel` that sends `Escape`) are not rows. A grammar that hides rows from `options` (omp's
   * `/switch` hides over-context and current rows) or whose arrow list holds a row without a
   * walk-class plan must therefore NOT set it: the visible edge would not be the real one.
   * This is the one fact about its list a grammar may hand the action layer. It never shapes a plan.
   */
  clampedEnds?: true;
  /**
   * Whether the dialog offers free-text / custom input ("Type something."). When true, the block
   * can render a dedicated action inviting the user to type their answer into the composer.
   */
  customInput?: boolean;
  /** The custom answer text already recorded for this dialog, if any. */
  customAnswer?: string;
  /**
   * The dialog's identity, independent of everything OUR OWN choreography changes: the `❯` pointer,
   * the feedback row's contents, and the row's HEIGHT (a long value wraps, which re-flows the screen
   * above it). Runs from the QUESTION — not `signature`'s wider lookback — with pointers normalised
   * and the whole feedback block collapsed to one token. The feedback flow moves all three by design,
   * so its mid-flight polls compare THIS. Narrower than `signature` by exactly the subject above the
   * question, which is the part that provably drifts under the flow's own keystrokes; the ENTRY guard
   * still compares the full `signature`, so a stale tap never starts against the wrong dialog.
   * Mirrors preview-select's `coreSignature`, for the same reason.
   */
  coreSignature: string;
  /**
   * A byte-signature of the dialog's on-screen region — a bounded run of lines from ABOVE the first
   * option (capturing the subject: the diff/command/context the dialog is about) through the footer.
   * The race guard compares this so a same-SHAPED successor dialog (identical question + labels but a
   * different subject — e.g. a second edit to the same file) can't pass as the one the user saw.
   * Herdr's `revision` is a stub, so this content signature is the load-bearing freshness check —
   * it MUST be non-empty and MUST change when the region's text changes.
   */
  signature: string;
  /**
   * The canonical styled lines of the SAME rows as {@link signature} (`canonicalStyledLines`,
   * lib/styled-region.ts), as the wire value `encodeStyledRegion` builds: a `v1` format line, then
   * the lines, joined with "\n". Set ONLY by a grammar whose pointer, or any other state
   * a tap depends on, is visible only as a style: the bridge binds a write to the text alone, so a
   * pointer that is not in the text is invisible to it. With this set, the phone sends it as
   * `expected_styled` beside the text region and the bridge compares the colours of the very read it
   * is about to answer (ADR 0080 point 7). `promptsEqual` compares it, so a stale tap on a moved
   * style is refused at entry; `promptsSameIdentity` does not, because the pointer is the one thing a
   * walk moves. Absent for every grammar that draws its pointer as a glyph.
   */
  styledSignature?: string;
}

/**
 * Whether two derivations are the SAME on-screen prompt — not merely the same shape. `signature`
 * (the dialog's region text, incl. the subject above the options) is the decisive check: two edits to
 * the same file yield an identical family/question/labels but a different signature, so a stale tap on
 * one can't approve the other. The family/question/label checks stay as a cheap fast-path and to keep
 * the intent explicit. (`revision` is a stub, so this content comparison is the real freshness guard.)
 *
 * Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 * adapter produced the block through exactly this function.
 */
export function promptsEqual(a: PromptModel, b: PromptModel): boolean {
  return (
    promptsSameIdentity(a, b) &&
    a.signature === b.signature &&
    // The feedback row's VISIBLE state, which the identity check deliberately ignores. A committing
    // digit must not fire across a change to it: focus decides whether that digit answers at all, and
    // text appearing in the box means someone at the terminal is typing into this very dialog.
    a.feedback?.focused === b.feedback?.focused &&
    a.feedback?.text === b.feedback?.text &&
    // The EXACT plan of every option, walk included. `promptsSameIdentity` ignores the arrow count
    // (ADR 0080), so for a grammar that draws its pointer as a glyph the byte-faithful `signature`
    // already refuses a moved pointer. A grammar that draws it as a style only (opencode's chip
    // background) has the same text with the pointer anywhere, and the only trace of the pointer is
    // each option's plan. Without this line a stale tap on such a dialog would pass the entry guard.
    a.options.every((o, i) => sameKeys(o.keys, b.options[i]!.keys)) &&
    // The colours of the region, for a grammar whose pointer is a style. The plans above are one
    // trace of such a pointer; this is the other, and the one the bridge is handed to bind to.
    a.styledSignature === b.styledSignature
  );
}

/**
 * "Same dialog" only — the weaker comparison for the keystrokes whose OWN effect is the change. The
 * feedback flow's digit focuses the input and its typing fills it, so `focused`, `text`, and the
 * pointer- and text-dependent `signature` all move by design; `coreSignature` is what stays put.
 * Everything that would re-route a keystroke to a DIFFERENT dialog still participates.
 *
 * Part of the CONTRACT, not of any harness — harness/dialog-contract.ts wires it in as
 * prompt-select's `identity`. Defined through {@link identityDiff}, so the verdict and its
 * explanation can never disagree.
 */
export function promptsSameIdentity(a: PromptModel, b: PromptModel): boolean {
  return identityDiff(a, b) === null;
}

/** A value for a diagnosis line: cut to a readable length. */
function clip(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** The first line where two multi-line signatures differ, with both lines. */
function firstLineDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const n = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < n; i++) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}: ${JSON.stringify(clip(aLines[i] ?? "(none)"))} vs ${JSON.stringify(clip(bLines[i] ?? "(none)"))}`;
    }
  }
  return "";
}

/**
 * The FIRST field in which two derivations are not the same dialog, or null when they are
 * ({@link promptsSameIdentity} is exactly `identityDiff(a, b) === null`). Fields are checked in a
 * fixed order and named for a one-line diagnosis of a refused tap, which used to answer a bare
 * `changed` and hid a grammar defect until a live test:
 *
 *   `family` · `question` · `coreSignature` (with the first differing line, both lines cut to 120
 *   characters) · `feedback` · `options.length` · `clampedEnds` · `option[i].label` · `option[i].keys`
 *
 * Pure, and for a person reading a console: the strings are not UI text and are never translated.
 */
export function identityDiff(a: PromptModel, b: PromptModel): string | null {
  if (a.family !== b.family) return `family: ${a.family} vs ${b.family}`;
  if (a.question !== b.question) return "question";
  if (a.coreSignature !== b.coreSignature) {
    return `coreSignature ${firstLineDiff(a.coreSignature, b.coreSignature)}`;
  }
  // The row's key and purpose, not its state: a feedback row that appeared, vanished,
  // renumbered, or changed purpose is a different dialog, and the flow's remaining
  // keystrokes would be aimed at the wrong row.
  if (a.feedback?.key !== b.feedback?.key || a.feedback?.purpose !== b.feedback?.purpose) {
    return "feedback";
  }
  if (a.options.length !== b.options.length) {
    return `options.length: ${a.options.length} vs ${b.options.length}`;
  }
  // A declared fact about the list, not a state: a model that gained or lost it is another
  // grammar's reading, and the commit batch the action layer builds from it would differ.
  if (a.clampedEnds !== b.clampedEnds) return "clampedEnds";
  if ((a.customInput ?? false) !== (b.customInput ?? false)) return "customInput";
  if (a.customAnswer !== b.customAnswer) return "customAnswer";
  // The arrow COUNT of a pointer walk is not compared (ADR 0080): a walk is a claim about where
  // the pointer stands, and the pointer is our own choreography's effect, which `coreSignature`
  // already blanks. `promptsEqual` still compares the byte-faithful `signature`, which carries
  // the pointer, so a stale tap is refused at entry; only the mid-flight identity polls, which
  // watch the pointer arrive, stop caring where it stood.
  for (let i = 0; i < a.options.length; i++) {
    const x = a.options[i]!;
    const y = b.options[i]!;
    if (x.label !== y.label) {
      return `option[${i}].label: ${JSON.stringify(clip(x.label))} vs ${JSON.stringify(clip(y.label))}`;
    }
    if (!sameKeysModuloWalk(x.keys, y.keys)) {
      return `option[${i}].keys: ${clip(x.keys.join(","))} vs ${clip(y.keys.join(","))}`;
    }
  }
  return null;
}

/** Exact keystroke-plan equality — a label can map to a different digit across hidden-row layouts. */
export function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Split a keystroke plan into its pointer walk and its commit: non-null exactly when `keys` is
 * `(Up|Down|Left|Right)* Enter` (the walk may be empty). Digits, `["y"]`, `["Escape"]`,
 * `["1", "Enter"]` and a lone `["Left"]` (a back key) are not walks and give null. The walk need not
 * be one direction here; the conformance suite requires that of every grammar. The action layer (lib/prompt-action.ts) sends the walk, verifies the
 * pointer on the tapped row, and only then commits (ADR 0080).
 */
export function splitWalk(keys: string[]): { walk: string[]; commit: string[] } | null {
  if (keys.length === 0 || keys[keys.length - 1] !== "Enter") return null;
  const walk = keys.slice(0, -1);
  if (!walk.every((k) => k === "Up" || k === "Down" || k === "Left" || k === "Right")) return null;
  return { walk, commit: ["Enter"] };
}

/** {@link sameKeys}, except that two walk-class plans (per {@link splitWalk}) are equal whatever
 *  their arrow counts or directions: the walk depends on where the pointer stood. */
export function sameKeysModuloWalk(a: string[], b: string[]): boolean {
  if (splitWalk(a) !== null && splitWalk(b) !== null) return true;
  return sameKeys(a, b);
}

/**
 * The keys of the COMMIT step for the walk-class option at `index` (ADR 0080 point 6): `["Enter"]`,
 * except on a list the grammar declared `clampedEnds`, where the first row commits as
 * `["Up","Enter"]` and the last as `["Down","Enter"]`. On a clamped list the extra arrow toward the
 * edge changes nothing when the pointer is already on the edge row, and it pulls a pointer that a
 * desk keystroke moved one row back onto it. The first row wins on a one-row list. Rows are the
 * options whose plan is walk-class; any other option (Cancel) is not a row of the list. An `index`
 * that is not a row gives `["Enter"]`. The sticky arrow is vertical only: a model whose walked plans
 * are horizontal (opencode's chips, which wrap) never sets `clampedEnds`, and gets `["Enter"]`. No
 * horizontal clamp is invented here.
 */
export function commitKeysFor(model: PromptModel, index: number): string[] {
  if (model.clampedEnds !== true) return ["Enter"];
  const rows: number[] = [];
  model.options.forEach((o, i) => {
    if (splitWalk(o.keys) !== null) rows.push(i);
  });
  if (rows.length === 0 || !rows.includes(index)) return ["Enter"];
  // Horizontal walks (Left/Right) have no declared clamp: nothing here says what a sticky arrow
  // would do on such a list, so the commit stays the plain Enter.
  if (rows.some((i) => splitWalk(model.options[i]!.keys)!.walk.some((k) => k === "Left" || k === "Right"))) {
    return ["Enter"];
  }
  if (index === rows[0]) return ["Up", "Enter"];
  if (index === rows[rows.length - 1]) return ["Down", "Enter"];
  return ["Enter"];
}

/** {@link sameKeys} for a plan a model may leave out: absent equals only absent. */
export function sameOptionalKeys(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameKeys(a, b);
}

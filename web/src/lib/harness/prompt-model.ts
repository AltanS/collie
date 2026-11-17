// The PROMPT-SELECT MODEL — the harness-NEUTRAL payload of a `prompt-select` Block.
//
// A single-choice dialog: a question, a list of options, and the family whose verified keystroke
// recipe each option's `keys` already encodes. Any adapter can produce one; the renderer
// (components/prompt-select-block.tsx) and the race guard (lib/prompt-action.ts → lib/dialog-guard.ts)
// are written against these types alone, never against a harness's internals.
//
// Types + the pure IDENTITY COMPARATOR, no detection and no harness conventions. Claude's reference
// detector is harness/claude/prompt-select.ts. This module imports nothing at runtime, so
// `lib/blocks.ts` can re-export it without a cycle. Its two imports are TYPES: a styled segment from
// `lib/ansi.ts` and a column range from `lib/column-range.ts`, leaves that import neither blocks.ts
// nor harness/, so not even a type-level cycle exists: {@link PromptSubjectLine} spells a
// StyledLine's shape over the first instead of importing StyledLine from blocks.ts.

import type { AnsiSegment } from "../ansi";
import type { ColumnRange } from "../column-range";

/**
 * One row of a dialog's SUBJECT ({@link PromptModel.subject}), styles kept. Structurally a
 * `StyledLine` (lib/blocks.ts), which is assignable to it and from it, spelled here so this module
 * need not import blocks.ts, which re-exports it.
 */
export interface PromptSubjectLine {
  segments: AnsiSegment[];
  /**
   * `warning` marks a row the dialog prints as a WARNING about the request, which the card draws in
   * the caution tone: Claude's `│`-guttered rows under the dialog's last `╌` rule, such as
   * "Dangerous rm operation not ruled out …". Absent on every other row. Display only.
   */
  tone?: "warning";
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
 * Why the inline free-text row exists. Absent means Claude's plan-approval input. Collie types into
 * two purposes, each by its own recipe: `plan-change` and `answer`.
 *
 *   - `plan-change` — Claude's "Tell Claude what to change": the digit focuses the field, typing
 *     fills it, Enter denies the plan and hands the agent the text (PLAN_FEEDBACK_NOTES.md).
 *   - `answer` — Claude's AskUserQuestion `Type something.` field: typed into and submitted as the
 *     question's answer by `lib/answer-field.ts` (ADR 0113, ASK_FIELD_NOTES.md). Its digit focuses
 *     the field only while it is empty; on a filled field it submits the held text.
 *   - `free-text` — a text field Collie reads and does not type into: a permission dialog's amend
 *     note, or another harness's custom-answer row (Grok's `z`). Parsed so a focused row can lock
 *     the option buttons. Neither Claude recipe fits it (different key, different Enter,
 *     unmeasured caret/wrap).
 */
export type PromptFeedbackPurpose = "plan-change" | "answer" | "free-text";

/**
 * Where `❯` sits relative to an `answer` field, among the menu's rows: on a row above it, on the
 * field itself (`on`, exactly when `focused`), on a row below it (`Chat about this`), or nowhere.
 */
export type AnswerFieldPointer = "above" | "on" | "below" | "none";

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
  /** Set on `answer` rows only: where the pointer stands, which the walk onto a filled field reads.
   *  Not part of the dialog's identity (`identityDiff`): the walk moves it on purpose. */
  pointer?: AnswerFieldPointer;
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
   * question. A dialog whose top edge is above the read gets the rows that are in it instead, and
   * {@link subjectCut}. Display only: it plays no part in identity, `signature` already covers these rows.
   * The card used to leave the subject in the raw mirror above it, which the docked card (ADR 0059)
   * and the journal-based Chat view no longer show.
   */
  subject?: PromptSubjectLine[];
  /**
   * The dialog's top is ABOVE the read: its top edge, and maybe its header and the start of its
   * command, scrolled off the screen (a command taller than the pane). {@link subject} then holds
   * only the dialog's rows that ARE in the read, from the read's first row down to the question, or
   * is absent when the question is the first thing in it. The card says the request starts above the
   * screen. Display only, like `subject`: the ask still has no region (`askRegion: null`), and
   * `signature` is what it was, so a tap goes the way it went before (the Ask route refuses it,
   * bridge/surface/ask.ts `NO_EDGE_DETAIL`). Absent whenever the top edge is in the read.
   */
  subjectCut?: true;
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
   * The dialog block alone, for the bridge's single-use ask id (M56 spec 08): the rows from the
   * dialog's own top edge to the footer, joined. That is the header, the subject inside the frame,
   * the question, the option labels and the key hints. Nothing above the edge: {@link signature}
   * reaches into the transcript, where a tool row's blinking bullet changes it every second, so an
   * ask bound to it changed under every tap. A grammar holds still what the dialog redraws on its
   * own, a countdown to answering itself (claude/prompt-select.ts), for the same reason.
   *
   * Set by a grammar whose `signature` reads above the dialog. `null` means that grammar found no
   * edge: the bridge then refuses a tap, and never binds to the lookback instead. Absent means the
   * grammar's `signature` already starts at the dialog, so the bridge binds to that.
   */
  askRegion?: string | null;
  /**
   * The same rows as {@link askRegion}, from the dialog's own top edge to the footer, as LITERAL text:
   * nothing held still. It is what a guarded key tap binds its first write to (the bridge's expected
   * prompt), in place of {@link signature}, whose lookback reaches into the transcript. A row there
   * that ticks (a tool's timer, a spinner, a clock) changed the bound region between the phone's read
   * and the bridge's, and the bridge refused the tap. The rows are a suffix of `signature`'s rows,
   * so the bridge finds them wherever it found `signature`, ending at the same row. A grammar may
   * start them lower, below a row the dialog itself redraws (Claude's self-answer countdown): the
   * phone has already compared the whole dialog by `askRegion`, and the bridge checks the rest.
   *
   * Its presence is also a fact the comparisons read: the rows under the edge hold what the dialog
   * asks about. `promptsEqual` and the ask id (lib/surface/lift.ts) compare `askRegion` only then.
   *
   * Set only with a string {@link askRegion} whose rows under the edge hold the subject (a rule
   * right above the question proves no frame), and never with {@link styledSignature} or
   * {@link bindColumns}: those describe `signature`'s rows, so a model that carries one binds
   * `signature` (harness/dialog-contract.ts).
   */
  bindRegion?: string;
  /**
   * The dialog's own rows as ORDERED LITERAL PARTS, when a row the dialog redraws by itself sits inside
   * them (Claude's self-answer countdown): the rows from the edge down to that row, then the rows after
   * it to the footer, which is {@link bindRegion}. The phone sends the list as `expected_prompt` and the
   * bridge checks every part on its fresh read, in order, the last ending where a single region would,
   * with only the left-out rows between them (bridge/prompt-binding.ts `verifyPromptParts`). So the
   * subject is checked at the moment of the key, and only the moving clock is not. An older bridge
   * refuses a list as a malformed `expected_prompt`, so it never types on a binding it cannot check.
   * Absent when no such row is in the dialog: the single region is the whole binding.
   */
  bindParts?: string[];
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
  /**
   * The display columns of the region's rows that {@link signature} was read from, when that is not
   * the whole row (`lib/column-range.ts`). Set ONLY by a grammar that reads its dialog from part of
   * each row because something beside it on the same rows moves on its own: Oh My Pi's side panel,
   * which ticks a clock beside the dialog (harness/pi/panel.ts). The phone sends it as
   * `expected_columns` beside the region, and the bridge cuts every row of its fresh read to the same
   * columns before it compares, so a change outside the range does not refuse the tap and a change
   * inside it does. `signature` (and `styledSignature`) must then hold exactly those columns of each
   * row. Absent means whole rows, which every other grammar binds: nothing changes for them, and an
   * older bridge that ignores the field compares whole rows and refuses the tap, which fails closed.
   * `identityDiff` compares it: a model that gained, lost or moved its range is another reading.
   */
  bindColumns?: ColumnRange;
  /**
   * How many of the read's last non-blank rows the region may end in, when that is more than the
   * bridge's default six (`lib/tail-lines.ts`). Set ONLY by a grammar that has recognised every row
   * below its region as its harness's OWN chrome, painted live under the dialog: Hermes's classic CLI
   * keeps a spinner, a countdown hint, a status bar and the input row under every panel, six or seven
   * rows that tick every second and so cannot be bound. The phone sends it as `expected_tail_lines`
   * beside the region and the bridge widens its tail window to it, never past `MAX_TAIL_LINES`. Built
   * with `tailLinesFor`, which adds one row of headroom. Absent means the default window, which every
   * other grammar binds; an older bridge ignores the field, keeps six rows and refuses the tap.
   *
   * Three roads were refused (ADR 0108). Binding the rows down to the tail, clocks and all: the region
   * changes every second and no tap ever lands. Raising the bridge's default window for everyone: the
   * other harnesses' dialogs sit at the tail, so it buys them nothing and widens how far up a stale
   * match may sit and still be accepted. Teaching the bridge to blank the clocks: the bridge holds no
   * pane grammar, and a Hermes rule in it would be the first. Revisit if a second harness needs a window
   * past 12 rows, or if Herdr grows a conditional write that checks the screen on its side.
   *
   * Not part of identity: it counts chrome outside the dialog, which a status row that wraps may
   * move by one without the dialog changing at all.
   */
  bindTail?: number;
}

/**
 * Whether two derivations are the SAME on-screen prompt — not merely the same shape. The dialog's own
 * rows (`sameDialogRows`: the header, the subject or command, the question, the options with the
 * pointer, the footer) are the decisive check: two edits to the same file, or two Bash commands, yield
 * an identical family/question/labels but different rows, so a stale tap on one can't approve the
 * other. The family/question/label checks stay as a cheap fast-path and to keep the intent explicit.
 * This content comparison is the whole freshness guard: the race guard no longer refuses on a moved
 * pane revision, because a row outside the dialog that ticks moves it (lib/harness/guard.ts).
 *
 * Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 * adapter produced the block through exactly this function.
 */
export function promptsEqual(a: PromptModel, b: PromptModel): boolean {
  return (
    promptsSameIdentity(a, b) &&
    sameDialogRows(a, b) &&
    // The feedback row's VISIBLE state, which the identity check deliberately ignores. A committing
    // digit must not fire across a change to it: focus decides whether that digit answers at all, and
    // text appearing in the box means someone at the terminal is typing into this very dialog.
    a.feedback?.focused === b.feedback?.focused &&
    a.feedback?.text === b.feedback?.text &&
    // The EXACT plan of every option, walk included. `promptsSameIdentity` ignores the arrow count
    // (ADR 0080), so for a grammar that draws its pointer as a glyph the byte-faithful dialog rows
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
 * Whether two derivations show the same dialog rows. Where the grammar found the dialog's own top edge
 * AND rows under it that hold the subject (`bindRegion` set on both), it compares `askRegion`, the rows
 * from that edge to the footer, byte for byte except the self-answer countdown the grammar holds still:
 * the transcript above the edge is not the dialog, and a timer, spinner or clock there ticks while a
 * subagent's dialog waits. Every other derivation compares the byte-faithful `signature`, lookback
 * included, as before: with no edge, or with a rule right above the question, a subject above the rule
 * would fall outside `askRegion`, and a successor with another command would compare equal. A pair
 * where only one side carries `bindRegion` is two readings of the screen, never the same dialog.
 *
 * Those rows are compared with their RUNNING rows held still ({@link tickSteadySignature}): a spinner
 * row or a running tool row above an unframed dialog ticks while the dialog waits, and the person
 * could not answer until it stopped. Every other row, the command or file a subject names included,
 * still compares byte for byte. The rows from the question down are compared exactly as well, by
 * `promptsSameIdentity` (`coreSignature`, the labels), the option plans and the feedback state, so the
 * hold reaches only the rows above the question.
 */
function sameDialogRows(a: PromptModel, b: PromptModel): boolean {
  if (a.bindRegion !== undefined && b.bindRegion !== undefined) return a.askRegion === b.askRegion;
  return a.bindRegion === b.bindRegion && sameUnframedRows(a.askRegion, b.askRegion) && sameUnframedRows(a.signature, b.signature);
}

/** Two optional runs of rows of an unframed dialog: equal as they are, or equal with their running
 *  rows held still. Absent equals only absent, and `null` (no edge) only `null`. */
function sameUnframedRows(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return tickSteadySignature(a) === tickSteadySignature(b);
}

/**
 * A spinner glyph at a row's lead, followed by a word: a braille spinner frame (U+2801 to U+28FF), or
 * one of the star frames a turn's spinner cycles through (`· ✢ ✳ ✶ ✻ ✽ *`). Not the `❯` pointer, not
 * a tool row's `⏺`, not a list dash: those are not ticks.
 */
const SPINNER_LEAD = /^(\s*)[\u2801-\u28ff·✢✳✶✻✽*](?=\s+\p{L})/u;
/** A bracket group right after an ellipsis: where a running row keeps its timer and its counters
 *  (`Running… (4m 12s · timeout 10m)`, `Wibbling… (4s · ↓ 304 tokens)`). */
const RUNNING_BRACKET = /(…|\.\.\.)(\s*)\(([^()]*)\)/gu;

/**
 * One row as the unframed comparison sees it, with what a running row redraws on its own held still.
 * Two shapes, both harness-neutral:
 *
 *   - a SPINNER row, a spinner glyph at its lead then a word ("✻ Churned for 4s · done 12:15 AM",
 *     "⠋ working 3s"): the glyph reads as `*` and every digit run as `0`;
 *   - a RUNNING row, a bracket group right after an ellipsis ("⎿  Running… (4m 12s · timeout 10m)"):
 *     the digit runs inside that group read as `0`, and nothing else on the row moves.
 *
 * Every other row is returned as it is, so a command, a file or a question that differs in a single
 * character, a digit included ("kill 1234" against "kill 5678"), still differs. A row that changes
 * its words, or gains or loses a spinner lead, still differs too. The bridge's own unframed compares
 * hold the same kinds of row still (bridge/surface/protocol.ts `steadyRow`); this module imports
 * nothing at runtime, so the rule is spelled here.
 */
function tickSteadyRow(row: string): string {
  if (SPINNER_LEAD.test(row)) return row.replace(SPINNER_LEAD, "$1*").replace(/\d+/gu, "0");
  return row.replace(RUNNING_BRACKET, (_all, ellipsis: string, gap: string, inner: string) => `${ellipsis}${gap}(${inner.replace(/\d+/gu, "0")})`);
}

/** A signature with each of its rows read by {@link tickSteadyRow}. Same row count, same order. */
function tickSteadySignature(signature: string): string {
  return signature.split("\n").map(tickSteadyRow).join("\n");
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
 *   characters) · `feedback` · `options.length` · `clampedEnds` · `bindColumns` · `option[i].label` ·
 *   `option[i].keys`
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
  // The columns the bridge will compare: a range that appeared, vanished or moved means the screen's
  // layout changed (OmO's side panel came, went or resized), and the binding would be another one.
  if (!sameBindColumns(a.bindColumns, b.bindColumns)) return "bindColumns";
  // The arrow COUNT of a pointer walk is not compared (ADR 0080): a walk is a claim about where
  // the pointer stands, and the pointer is our own choreography's effect, which `coreSignature`
  // already blanks. `promptsEqual` still compares the byte-faithful dialog rows, which carry
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

/** Two optional column ranges: absent equals only absent. Spelled here, not imported from
 *  `lib/column-range.ts`, so this module keeps importing nothing at runtime. */
function sameBindColumns(a: ColumnRange | undefined, b: ColumnRange | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.start === b.start && a.end === b.end;
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

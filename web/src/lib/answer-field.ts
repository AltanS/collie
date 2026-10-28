// The one recipe that types an answer into AskUserQuestion's `Type something.` field (ADR 0113),
// generic over the dialog kind so the single question, the wizard step and the multi-select question
// share it. The ground truth for every key below is grammar/ASK_FIELD_NOTES.md.
//
//   1. The field as the person saw it when they tapped (`seen`), then the entry guard.
//   2. REACH the field. Its digit only while it is EMPTY: on a filled field the digit submits the held
//      text at once (ASK_FIELD_NOTES hazard 1). A filled field is reached by a walk of `Up`/`Down`,
//      one arrow per verified read, bound to that read.
//   3. CLEAR it, only when it holds exactly what the person saw: rounds of `ctrl+u ctrl+k` (each clears
//      one visual line), re-read after each, capped.
//   4. TYPE through the reply path, and wait until the field reads exactly our text.
//
// Every step refuses on drift and sends nothing after the refusal. Nothing here commits: the caller
// sends the answering key (single question, wizard) bound to the read that proved the text, or leaves
// the row filled (multi-select).

import { sendReply } from "./api";
import { describeApiError, describeThrownError } from "./api-error-message";
import {
  guardDialog,
  pollDialog,
  readDialog,
  sendBoundKeys,
  type DialogTarget,
} from "./dialog-guard";
import { MAX_ANSWER_WRAP, OPTION_SCAN_WINDOW } from "./harness/claude/prompt-select";
import { DIALOG_CONTRACT, type DialogKind, type DialogModels } from "./harness/dialog-contract";
import { sanitizeTypedText, type ActionResult, type GuardOutcome, type Sleep } from "./harness/guard";
import type { AnswerFieldPointer } from "./harness/prompt-model";
import { t } from "./i18n";
import { displayWidth } from "./text-width";

/**
 * Longest text Collie types into the plan dialog's feedback row.
 *
 * Not a comfort limit — a grammar one. The row does not window long text: Claude re-flows the whole
 * value across as many display lines as it needs, which pushes the dialog's footer away from its
 * options. `MAX_FEEDBACK_WRAP` (harness/claude/prompt-select.ts) is how far that may go before the
 * screen stops parsing at all, and this is sized to stay inside it even on a narrow pane (~4 lines of
 * ~60 usable columns). Longer text isn't dangerous — the read-back check simply refuses and nothing is
 * submitted — but the dialog would drop off the phone, so we don't let it happen.
 */
export const FEEDBACK_MAX_LENGTH = 240;

/**
 * Longest text Collie types into AskUserQuestion's answer field: the editor's cap, before the pane's
 * width is known. That field is not the dialog's last row, so its wrap does not move the footer; what
 * bounds it is {@link MAX_ANSWER_WRAP}, checked against the pane's width before anything is typed
 * ({@link answerFits}). 4000 characters is about 25 rows of a 160-column pane.
 */
export const ANSWER_MAX_LENGTH = 4000;

/** Columns before the field's text: `❯ 4. ` on a single question and a wizard step, `❯ 4. [✔] ` on a
 *  multi-select question. The wider one counts for all three, so the estimate never runs short. */
const ANSWER_INDENT = 9;

/**
 * Most arrows the walk sends before it gives up. A Claude AskUserQuestion menu holds at most four
 * options, the field and `Chat about this`; a wizard or multi-select step adds `Submit`/`Next`. Twelve
 * covers the longest such list from either end with room for a repaint that swallowed a key.
 */
export const MAX_WALK = 12;

/**
 * Most `ctrl+u ctrl+k` rounds the clear sends. A value Collie typed is at most `MAX_ANSWER_WRAP` + 1
 * visual lines ({@link answerFits}), and each round clears at least one, so this always suffices for
 * a field Collie could have filled; a value that outlasts it is left as it is.
 */
export const MAX_CLEAR_ROUNDS = MAX_ANSWER_WRAP + 2;

/**
 * Whether `text`, typed into the field of a dialog whose rows are `region` while the field holds
 * `held`, keeps the dialog readable so the text can be proved: the field wraps onto no more than
 * {@link MAX_ANSWER_WRAP} continuation rows, and the whole region, with `held`'s rows swapped for the
 * text's, stays inside the grammars' {@link OPTION_SCAN_WINDOW}. The region starts at or above the
 * first option, so the second bound is on the safe side. The pane's width is the widest row of the
 * region (the dialog's rules span the pane). Claude wraps on word boundaries one column short of the
 * row (2.1.306), so the count is a greedy word wrap that wide, after the widest label prefix.
 */
export function answerFits(text: string, region: string, held = ""): boolean {
  const rows = region.split("\n");
  const room = Math.max(0, ...rows.map(displayWidth)) - ANSWER_INDENT - 1;
  if (room <= 0) return false;
  const typed = wrappedRows(text, room);
  return typed <= MAX_ANSWER_WRAP + 1 && rows.length - wrappedRows(held, room) + typed <= OPTION_SCAN_WINDOW;
}

/** The rows a greedy word wrap of `text` takes at `room` columns; an empty value is its placeholder's one row. */
function wrappedRows(text: string, room: number): number {
  let rows = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const w = displayWidth(word);
    if (used > 0 && used + 1 + w <= room) {
      used += 1 + w;
      continue;
    }
    if (used > 0) rows++;
    // A word wider than the row breaks across rows of its own.
    rows += Math.max(0, Math.ceil(w / room) - 1);
    used = w % room || (w === 0 ? 0 : room);
  }
  return rows;
}

/** The field's state as one kind's model reports it. */
export interface AnswerFieldState {
  /** The digit that focuses (or, on a filled single/wizard field, submits) the field. */
  key: string;
  focused: boolean;
  /** What the field holds, `""` while it shows its placeholder. */
  text: string;
  pointer: AnswerFieldPointer;
}

/** How the recipe reads one dialog kind. */
export interface FieldAccess<K extends DialogKind> {
  /** The field on this model, or null when the model has none. */
  fieldOf(m: DialogModels[K]): AnswerFieldState | null;
  /** Whether `m` is still the dialog the person tapped (identity, not visible state). */
  sameDialog(m: DialogModels[K]): boolean;
  /** Whether the field's digit focuses an empty field: true on a single question and a wizard step,
   *  false on a multi-select question, where it toggles the field's checkbox. */
  digitFocuses: boolean;
}

/** The recipe's outcome: the read that proved our text is in the field, or why it stopped. */
export type FillOutcome<K extends DialogKind> =
  | { ok: true; proof: DialogModels[K] }
  | { ok: false; result: ActionResult };

type Target<K extends DialogKind> = DialogTarget<K> & { sleep?: Sleep };
type Step<K extends DialogKind> = FillOutcome<K>;
type Failure = { ok: false; result: ActionResult };

const refuse = (why: string): Failure => ({ ok: false, result: { status: "changed", why } });
const fail = (error: string): Failure => ({ ok: false, result: { status: "error", error } });

/** A refused write keeps the bridge's own reason; anything else that is not `sent` passes through. */
function notSent(result: ActionResult, why: string): Failure {
  return { ok: false, result: result.status === "changed" ? { status: "changed", why: result.why ?? why } : result };
}

/** Send `keys` bound to the region of `m`, the read that showed the state the keys are aimed at. */
function sendBoundTo<K extends DialogKind>(target: Target<K>, keys: string[], m: DialogModels[K]): Promise<ActionResult> {
  const contract = DIALOG_CONTRACT[target.kind];
  return sendBoundKeys(target, keys, contract.region(m), contract.styled?.(m), contract.columns?.(m));
}

/**
 * Fill the answer field of `target.model` with `text`, sanitised and cut to
 * {@link ANSWER_MAX_LENGTH}. Sends no committing key. Refuses (`changed`, with the step in `why`)
 * when the dialog or the field moved under it; errors when a step's awaited state never came, or,
 * before any key, when the text would wrap the dialog off the pane's screen.
 */
export async function fillAnswerField<K extends DialogKind>(
  target: Target<K>,
  access: FieldAccess<K>,
  text: string,
): Promise<FillOutcome<K>> {
  const seen = access.fieldOf(target.model);
  if (seen === null) return refuse("entry");
  const clean = sanitizeTypedText(text, ANSWER_MAX_LENGTH);
  if (clean.length === 0) return fail(t("promptAction.feedback.empty"));
  try {
    const guarded = await guardDialog(target);
    if (!guarded.ok) return notSent(guarded.result, "entry");
    if (!answerFits(clean, guarded.region, seen.text)) return fail(t("promptAction.answer.tooLong"));
    const reached = await reachField(target, access, seen, guarded);
    if (!reached.ok) return reached;
    const cleared = await clearField(target, access, reached.proof);
    if (!cleared.ok) return cleared;
    return await typeAnswer(target, access, clean);
  } catch (e) {
    return fail(describeThrownError(e));
  }
}

/** Step 2: put the keyboard in the field, then prove it is focused and still holds `seen.text`. */
async function reachField<K extends DialogKind>(
  target: Target<K>,
  access: FieldAccess<K>,
  seen: AnswerFieldState,
  guarded: Extract<GuardOutcome, { ok: true }>,
): Promise<Step<K>> {
  if (!seen.focused) {
    if (access.digitFocuses && seen.text === "") {
      const sent = await sendBoundKeys(target, [seen.key], guarded.region, guarded.styled, guarded.columns);
      if (sent.status !== "sent") return notSent(sent, "bridge");
    } else {
      const walked = await walkToField(target, access, seen);
      if (!walked.ok) return walked;
    }
  }
  const polled = await pollDialog(target, (m) => access.sameDialog(m) && (access.fieldOf(m)?.focused ?? false));
  if (polled.status === "drifted") return refuse("reach: drift");
  if (polled.status === "timeout") return fail(t("promptAction.answer.fieldNotReached"));
  // Someone at the desk typed between the tap and now: their words are not ours to clear.
  if (access.fieldOf(polled.model)?.text !== seen.text) return refuse("reach: text");
  return { ok: true, proof: polled.model };
}

/**
 * The walk onto a field whose digit must not be sent: one arrow per fresh read, toward the field from
 * where that read shows the pointer, bound to that read, then a poll until the screen moved. Stops
 * on the read that shows the field focused.
 */
async function walkToField<K extends DialogKind>(
  target: Target<K>,
  access: FieldAccess<K>,
  seen: AnswerFieldState,
): Promise<{ ok: true } | Failure> {
  const regionOf = DIALOG_CONTRACT[target.kind].region;
  let current = (await readDialog(target)).model;
  for (let step = 0; step < MAX_WALK; step++) {
    if (current === null || !access.sameDialog(current)) return refuse("walk: drift");
    const field = access.fieldOf(current);
    if (field === null) return refuse("walk: drift");
    if (field.text !== seen.text) return refuse("walk: text");
    if (field.focused) return { ok: true };
    const sent = await sendBoundTo(target, [field.pointer === "below" ? "Up" : "Down"], current);
    if (sent.status !== "sent") return notSent(sent, "bridge");
    const before = regionOf(current);
    const moved = await pollDialog(target, (m) => regionOf(m) !== before);
    if (moved.status === "drifted") return refuse("walk: drift");
    if (moved.status === "timeout") return fail(t("promptAction.answer.fieldNotReached"));
    current = moved.model;
  }
  return fail(t("promptAction.answer.fieldNotReached"));
}

/** Step 3: empty a focused field, a round of `ctrl+u ctrl+k` per read, until a read shows it empty. */
async function clearField<K extends DialogKind>(
  target: Target<K>,
  access: FieldAccess<K>,
  proof: DialogModels[K],
): Promise<Step<K>> {
  let current = proof;
  for (let round = 0; round < MAX_CLEAR_ROUNDS; round++) {
    const before = access.fieldOf(current)?.text ?? "";
    if (before === "") return { ok: true, proof: current };
    const sent = await sendBoundTo(target, ["ctrl+u", "ctrl+k"], current);
    if (sent.status !== "sent") return notSent(sent, "bridge");
    const polled = await pollDialog(target, (m) => {
      const field = access.fieldOf(m);
      return access.sameDialog(m) && field !== null && field.focused && field.text !== before;
    });
    if (polled.status === "drifted") return refuse("clear: drift");
    if (polled.status === "timeout") return fail(t("promptAction.answer.notCleared"));
    current = polled.model;
  }
  return access.fieldOf(current)?.text === "" ? { ok: true, proof: current } : fail(t("promptAction.answer.notCleared"));
}

/** Step 4: paste our text into the focused, empty field, and wait for exactly that text. */
async function typeAnswer<K extends DialogKind>(
  target: Target<K>,
  access: FieldAccess<K>,
  clean: string,
): Promise<Step<K>> {
  const typed = await sendReply(target.paneId, clean, false, target.scope);
  if (!typed.ok) return fail(describeApiError(typed));
  const landed = await pollDialog(target, (m) => {
    const field = access.fieldOf(m);
    return access.sameDialog(m) && field !== null && field.focused && field.text === clean;
  });
  if (landed.status === "drifted") return refuse("type: drift");
  if (landed.status === "timeout") return fail(t("promptAction.answer.notArrived"));
  return { ok: true, proof: landed.model };
}

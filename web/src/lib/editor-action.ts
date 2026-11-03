import type { Scope } from "./scope";
import { defaultSleep, POLL_ATTEMPTS, POLL_DELAY_MS, pollUntil, readModel, sanitizeTypedText, type ActionResult, type Sleep } from "./harness/guard";
import { adapterFor } from "./harness/registry";
import { guardDialog, pollDialog, readDialog, sendBoundKeys, type DialogTarget } from "./dialog-guard";
import { DIALOG_CONTRACT, type DialogModels } from "./harness/dialog-contract";
import { describeApiError, describeThrownError } from "./api-error-message";
import { sendReply } from "./api";
import { FEEDBACK_MAX_LENGTH } from "./harness/prompt-model";
import { NOTE_MAX_LENGTH } from "./harness/preview-model";
import type { DialogEditorObservation } from "./harness/editor-model";

export interface EditorReadTarget {
  paneId: string;
  requestedLines: number;
  scope?: Scope;
  agent?: string;
  ownerSignature: string;
  purpose: DialogEditorObservation["purpose"];
  sleep?: Sleep;
}
export type EditorReadResult =
  | { status: "read"; text: string; observation: DialogEditorObservation }
  | Exclude<ActionResult, { status: "sent" }>;

export type EditorKind = "multi-select" | "preview-select";
export type EditorDialog = { [K in EditorKind]: { kind: K; model: DialogModels[K] } }[EditorKind];
type EditorTarget = DialogTarget<EditorKind>;

export interface SeenValue {
  text: string;
  /** Scoped, complete originating dialog. Temporary client context, not a server token. */
  origin: EditorTarget;
  purpose: DialogEditorObservation["purpose"];
  contextSignature: string;
}
export type EditorPrepareResult =
  | { status: "ready"; seen: SeenValue; observation: DialogEditorObservation }
  | Exclude<ActionResult, { status: "sent" }>;

async function waitForOwnedEditor(target: EditorReadTarget, accept: (editor: DialogEditorObservation) => boolean = () => true) {
  const adapter = adapterFor(target.agent);
  const owns = (editor: DialogEditorObservation) => editor.ownerSignature === target.ownerSignature && editor.purpose === target.purpose;
  const waited = await pollUntil<DialogEditorObservation | null>(target, null,
    (lines) => adapter?.observeDialogEditor?.(lines) ?? null,
    (editor) => editor !== null && owns(editor) && accept(editor), (editor) => editor !== null && owns(editor));
  return waited.status === "ok" && waited.model !== null ? { status: "observed" as const, observation: waited.model } :
    { status: "changed" as const, why: `owned editor ${waited.status}` };
}

export async function prepareDialogEditor(
  origin: EditorTarget,
  purpose: DialogEditorObservation["purpose"],
): Promise<EditorPrepareResult> {
  const editors = origin.model.editors;
  const plan = purpose === "answer" ? editors?.answer : editors?.note;
  if (editors === undefined || plan === undefined) return { status: "changed" };
  const review = "phase" in origin.model && origin.model.phase === "review";
  if (purpose === "question-note" && review || purpose === "global-note" && !review) return { status: "changed" };
  // A note hotkey in the inline input is text, not an editor-opening command.
  if (purpose !== "answer" && editorField(origin.model)?.focused) return { status: "changed" };
  const guarded = await guardDialog(origin);
  if (!guarded.ok) return guarded.result.status === "sent" ? { status: "changed" } : guarded.result;
  const keys = purpose === "answer" ? editors.answer!.focusKeys : origin.model.note?.state === "editing" ? [] : editors.note!.openKeys;
  if (keys.length > 0) {
    const sent = await sendBoundKeys(origin, keys, guarded.region, guarded.styled);
    if (sent.status !== "sent") return sent;
  }
  const target = { ...origin, ownerSignature: editors.ownerSignature, purpose };
  const focused = await waitForOwnedEditor(target);
  if (focused.status !== "observed") return focused;
  const read = await readDialogEditor(target);
  if (read.status !== "read") return read;
  if (purpose === "answer") {
    const drift = await answerDialogDrift(origin);
    if (drift !== null) return drift;
  }
  return { status: "ready", observation: read.observation, seen: {
    text: read.text, origin, purpose, contextSignature: read.observation.contextSignature,
  } };
}

function seenTarget(seen: SeenValue): EditorReadTarget {
  return { ...seen.origin, ownerSignature: seen.origin.model.editors?.ownerSignature ?? "", purpose: seen.purpose };
}
async function readSeenValue(seen: SeenValue): Promise<EditorReadResult> {
  const fresh = await readDialogEditor(seenTarget(seen));
  if (fresh.status !== "read") return fresh;
  return fresh.text === seen.text && fresh.observation.contextSignature === seen.contextSignature ? fresh :
    { status: "changed", why: "native value or editor context changed since it was read" };
}

function editorField(model: DialogModels[EditorKind]) {
  return "phase" in model ? model.phase === "checkbox" ? model.field : undefined : model.field;
}
function sameEditorDialog<K extends EditorKind>(origin: DialogTarget<K>, model: DialogModels[K], compareField: boolean): boolean {
  // Only a note lifecycle may change its own note. Ordinary answer/submit macros keep comparing it.
  let baseline = origin.model;
  if (compareField) {
    baseline = { ...origin.model, note: model.note };
    if ("phase" in model && model.phase === "review") baseline = { ...baseline, summaryClipped: model.summaryClipped };
  }
  if (!DIALOG_CONTRACT[origin.kind].identity(baseline, model)) return false;
  if (!compareField && (origin.model.note?.state !== model.note?.state || origin.model.note?.text !== model.note?.text)) return false;
  const before = editorField(origin.model), after = editorField(model);
  if (!compareField) return true;
  if (before === undefined || after === undefined) return before === after;
  return before.text === after.text && before.textComplete === after.textComplete &&
    ("checked" in before ? before.checked : undefined) === ("checked" in after ? after.checked : undefined);
}

/** Editor ownership alone may identify only a heading/chip. Answers still expose their choices,
 * so do not adopt a distinguishable successor's context or erase it after a focus/read race. */
async function answerDialogDrift(origin: EditorTarget): Promise<Exclude<ActionResult, { status: "sent" }> | null> {
  try {
    const fresh = await readDialog(origin);
    return fresh.model !== null && sameEditorDialog(origin, fresh.model, false) ? null :
      { status: "changed", why: "original answer dialog changed" };
  } catch (error) {
    return { status: "error", error: describeThrownError(error) };
  }
}

type EditorReturnResult = { status: "returned"; origin: EditorTarget } | Exclude<ActionResult, { status: "sent" }>;
async function returnFromEditor(seen: SeenValue, observation: DialogEditorObservation, text: string): Promise<EditorReturnResult> {
  // Up crosses visual rows inside a logical multiline value. Start each logical line first,
  // otherwise a wrapped tail can leave the editor focused even after one Up per real newline.
  const keys = seen.purpose === "answer" ? Array.from({ length: text.split("\n").length }, () => [...observation.keys.start, ...observation.keys.up]).flat() :
    seen.origin.model.editors?.note?.closeKeys;
  if (keys === undefined || keys.length === 0) return { status: "changed" };
  const sent = await sendBoundKeys(seen.origin, keys, observation.regionSignature, observation.styledSignature);
  if (sent.status !== "sent") return sent;
  const returned = await pollDialog(seen.origin, (model) => sameEditorDialog(seen.origin, model, seen.purpose !== "answer") &&
    model.note?.state !== "editing" && !editorField(model)?.focused);
  return returned.status === "ok" ? { status: "returned", origin: { ...seen.origin, model: returned.model, detectedRevision: returned.revision } } :
    { status: "changed", why: `editor return ${returned.status}` };
}

/** Explicit return, not rollback: RPIV's note exit deliberately saves the unchanged native value. */
export async function cancelDialogEditor(seen: SeenValue): Promise<ActionResult> {
  const fresh = await readSeenValue(seen);
  if (fresh.status !== "read") return fresh;
  const returned = await returnFromEditor(seen, fresh.observation, fresh.text);
  return returned.status === "returned" ? { status: "sent" } : returned;
}

export async function saveDialogEditor(seen: SeenValue, text: string): Promise<ActionResult> {
  const answer = seen.purpose === "answer";
  const limit = answer ? FEEDBACK_MAX_LENGTH : NOTE_MAX_LENGTH;
  if (text.length > limit) return { status: "changed", why: "replacement exceeds phone limit" };
  const sanitized = sanitizeTypedText(text, limit, true);
  const clean = answer ? sanitized : sanitized.trim(); // RPIV's note exit has these exact trim semantics.
  try {
    const fresh = await readSeenValue(seen);
    if (fresh.status !== "read") return fresh;
    let observation = fresh.observation;
    let currentText = fresh.text;
    if (answer) {
      const drift = await answerDialogDrift(seen.origin);
      if (drift !== null) return drift;
    } else {
      // Notes can cover the choices. Re-establish the FULL original dialog before any erasure,
      // then reopen and prove the complete value/context again. A matching heading is insufficient.
      const returned = await returnFromEditor(seen, observation, currentText);
      if (returned.status !== "returned") return returned;
      const reopened = await prepareDialogEditor(returned.origin, seen.purpose);
      if (reopened.status !== "ready") return reopened;
      if (reopened.seen.text !== seen.text.trim() || reopened.seen.contextSignature !== seen.contextSignature) {
        return { status: "changed", why: "native note changed while re-establishing its dialog" };
      }
      observation = reopened.observation;
      currentText = reopened.seen.text;
    }
    const editors = seen.origin.model.editors;
    const clearKeys = answer ? editors?.answer?.clearKeys : editors?.note === undefined ? undefined :
      Array.from({ length: currentText.split("\n").length }, () => editors.note!.clearLineKeys).flat();
    if (clearKeys === undefined) return { status: "changed" };
    const cleared = await sendBoundKeys(seen.origin, clearKeys, observation.regionSignature, observation.styledSignature);
    if (cleared.status !== "sent") return cleared;
    const target = seenTarget(seen);
    const empty = await waitForOwnedEditor(target, (editor) => editor.rows.length === 1 && editor.cursor.offset === 0 && editor.rows[0] === editor.cursor.cell);
    if (empty.status !== "observed") return empty;
    const emptyRead = await readDialogEditor(target);
    if (emptyRead.status !== "read") return emptyRead;
    if (emptyRead.text !== "") return { status: "changed", why: "native editor did not clear" };
    if (clean !== "") {
      const typed = await sendReply(seen.origin.paneId, clean, false, seen.origin.scope, emptyRead.observation.regionSignature, emptyRead.observation.styledSignature);
      if (!typed.ok) return typed.code === "prompt_changed" ? { status: "changed" } : { status: "error", error: describeApiError(typed) };
      const landed = await waitForOwnedEditor(target, (editor) => editor.rows.join("").replace(/\s/gu, "") === clean.replace(/\s/gu, ""));
      if (landed.status !== "observed") return landed;
    }
    const read = await readDialogEditor(target);
    if (read.status !== "read") return read;
    if (read.text !== clean) return { status: "changed", why: "replacement did not read back exactly" };
    const commitKeys = answer && clean.trim() !== "" ? editors?.answer?.commitKeys : undefined;
    if (commitKeys !== undefined) return sendBoundKeys(seen.origin, commitKeys, read.observation.regionSignature, read.observation.styledSignature);
    const returned = await returnFromEditor(seen, read.observation, clean);
    return returned.status === "returned" ? { status: "sent" } : returned;
  } catch (error) {
    return { status: "error", error: describeThrownError(error) };
  }
}

class ReadRefused extends Error {}
const atLineEnd = (editor: DialogEditorObservation) => editor.cursor.cell === (editor.layout === "boxed" ? " " : "\u00a0") &&
  editor.cursor.offset === editor.rows[editor.cursor.row]!.length - 1;
const contentOf = (editor: DialogEditorObservation) => {
  // Painting a breakable space as NBSP can reflow a whole word across a visual boundary. Fold
  // boundary whitespace, not interior runs: deleting all spaces would hide ordinary desk edits.
  // This is a visible-content guard, not an atomic logical-value comparison (save re-reads fully).
  const rows = editor.rows.map((row, index) => {
    const text = row.replace(/\u00a0/g, " ").trimEnd();
    return index === 0 ? text : text.trimStart();
  });
  while (rows.at(-1) === "") rows.pop();
  return rows.join(" ");
};
const limitOf = (editor: DialogEditorObservation) => editor.purpose === "answer" ? FEEDBACK_MAX_LENGTH : NOTE_MAX_LENGTH;
let segmenter: Intl.Segmenter | undefined;
const graphemes = (text: string) => Array.from((segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(text), (part) => part.segment);
const cursorMoved = (before: DialogEditorObservation, after: DialogEditorObservation) =>
  before.cursor.row !== after.cursor.row || before.cursor.offset !== after.cursor.offset;

/** Reads a focused editor; this alone never authorises a replacement or a native close. */
export async function readDialogEditor(target: EditorReadTarget): Promise<EditorReadResult> {
  const adapter = adapterFor(target.agent);
  const observe = () => readModel(target.paneId, target.requestedLines, target.scope,
    (lines) => adapter?.observeDialogEditor?.(lines) ?? null);
  const sleep = target.sleep ?? defaultSleep;
  try {
    const { model: initial } = await observe();
    if (initial === null || initial.ownerSignature !== target.ownerSignature || initial.purpose !== target.purpose) {
      throw new ReadRefused("not the complete owned editor");
    }
    const owned = initial;
    async function move(before: DialogEditorObservation, keys: string[], accept: (editor: DialogEditorObservation) => boolean) {
      const sent = await sendBoundKeys(target, keys, before.regionSignature, before.styledSignature);
      if (sent.status === "changed") throw new ReadRefused(sent.why ?? "bound cursor move refused");
      if (sent.status === "error") throw new Error(sent.error);
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        const { model: current } = await observe();
        if (current === null || current.ownerSignature !== owned.ownerSignature || current.contextSignature !== owned.contextSignature || current.purpose !== owned.purpose || current.layout !== owned.layout) {
          throw new ReadRefused("editor clipped or target changed");
        }
        if (contentOf(current) !== contentOf(owned) || (current.layout === "boxed" && current.regionSignature !== owned.regionSignature)) {
          throw new ReadRefused("visible content changed during readback");
        }
        if (accept(current)) return current;
      }
      throw new ReadRefused("cursor move was not observable");
    }
    async function logicalLine(first: DialogEditorObservation, end: DialogEditorObservation) {
      const parts = end.rows.slice(first.cursor.row, end.cursor.row + 1);
      parts[parts.length - 1] = parts.at(-1)!.slice(0, end.cursor.offset);
      let text = parts[0]!;
      let proof = end;
      let advance: number | undefined;
      for (let index = 1; index < parts.length; index++) {
        const part = parts[index]!;
        if (part === "") {
          if (index !== parts.length - 1) throw new ReadRefused("empty interior wrap not proved");
          proof = await move(proof, proof.keys.end, atLineEnd);
          const before = proof;
          proof = await move(proof, proof.keys.left, (editor) => cursorMoved(before, editor));
          if (proof.cursor.cell !== graphemes(text).at(-1)) throw new ReadRefused("trailing whitespace not proved");
          continue;
        }
        const leading = /^[ \u00a0]*/.exec(part)![0];
        const rest = part.slice(leading.length);
        if (rest === "") throw new ReadRefused("whitespace-only wrap tail is not proved");
        const prefix = graphemes(text);
        if (prefix.length > limitOf(first)) throw new ReadRefused("probe character budget exceeded");
        // After a proved boundary, the cursor is on the first grapheme of its visible rest.
        // Advance over that proved span, not the entire prefix again. The same anchor below
        // still proves each next boundary; replaying prefixes makes paced native reads quadratic.
        const keys = [
          ...(advance === undefined ? proof.keys.start : []),
          ...Array.from({ length: advance ?? prefix.length }, () => proof.keys.right).flat(),
        ];
        proof = await move(proof, keys, (editor) => {
          const beforeCursor = editor.rows.slice(first.cursor.row, editor.cursor.row).join("") + editor.rows[editor.cursor.row]!.slice(0, editor.cursor.offset);
          return beforeCursor.replace(/\s/gu, "") === text.replace(/\s/gu, "");
        });
        let gap = "";
        while (proof.cursor.cell === "\u00a0" || (first.layout === "boxed" && proof.cursor.cell === " ")) {
          if (gap.length >= limitOf(first)) throw new ReadRefused("whitespace probe bound exhausted");
          const before = proof;
          // Several logical wrap spaces can share a painted caret position. The measured default
          // binding advances one grapheme; the next visible character closes this bounded walk.
          proof = await move(proof, proof.keys.right, () => true);
          // Moving off the cell reveals whether an inline NBSP was literal or cursor-painted space.
          const beforeCursor = proof.rows.slice(first.cursor.row, proof.cursor.row).join("") +
            proof.rows[proof.cursor.row]!.slice(0, proof.cursor.offset);
          gap += first.layout === "boxed" ? before.cursor.cell : beforeCursor.endsWith("\u00a0") ? "\u00a0" : " ";
        }
        const restGraphemes = graphemes(rest);
        if (proof.cursor.cell !== restGraphemes[0] || !gap.endsWith(leading)) throw new ReadRefused("wrapping boundary did not match visible content");
        text += gap + rest;
        advance = restGraphemes.length;
      }
      if (parts.length > 1) proof = await move(proof, proof.keys.end, atLineEnd);
      return { text, proof };
    }
    let current = await move(initial, initial.keys.start, (editor) => editor.cursor.offset === 0);
    for (let count = 0; current.cursor.row > 0 && count < initial.rows.length; count++) {
      const row = current.cursor.row;
      current = await move(current, [...current.keys.up, ...current.keys.start], (editor) => editor.cursor.row < row && editor.cursor.offset === 0);
    }
    if (current.cursor.row !== 0) throw new ReadRefused("first logical line was not reached");
    const result: string[] = [];
    for (let count = 0; count <= initial.rows.length; count++) {
      const end = await move(current, current.keys.end, atLineEnd);
      const line = await logicalLine(current, end);
      result.push(line.text);
      const text = result.join("\n");
      if (text.length > limitOf(initial)) throw new ReadRefused("complete value exceeds phone limit");
      if (line.proof.cursor.row === line.proof.rows.length - 1) return { status: "read", text, observation: line.proof };
      current = await move(line.proof, line.proof.keys.right, (editor) => editor.cursor.row > line.proof.cursor.row && editor.cursor.offset === 0);
    }
    throw new ReadRefused("logical line bound exhausted");
  } catch (error) {
    return error instanceof ReadRefused ? { status: "changed", why: error.message } : { status: "error", error: describeThrownError(error) };
  }
}

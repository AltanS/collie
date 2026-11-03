// Optional observations/plans for native questionnaire editors. Pure data, never an answer store.
import { sameOptionalKeys } from "./prompt-model";

export interface DialogEditors {
  ownerSignature: string;
  answer?: { focusKeys: string[]; clearKeys: string[]; commitKeys?: string[] };
  note?: { openKeys: string[]; clearLineKeys: string[]; closeKeys: string[] };
}

/** Focus is transient; the measured clear/commit/close plans are not. */
export function sameDialogEditors(a: DialogEditors | undefined, b: DialogEditors | undefined, compareFocus = true): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.ownerSignature === b.ownerSignature &&
    (a.answer === undefined || b.answer === undefined ? a.answer === b.answer :
      (!compareFocus || sameOptionalKeys(a.answer.focusKeys, b.answer.focusKeys)) && sameOptionalKeys(a.answer.clearKeys, b.answer.clearKeys) && sameOptionalKeys(a.answer.commitKeys, b.answer.commitKeys)) &&
    (a.note === undefined || b.note === undefined ? a.note === b.note : sameOptionalKeys(a.note.openKeys, b.note.openKeys) &&
      sameOptionalKeys(a.note.clearLineKeys, b.note.clearLineKeys) && sameOptionalKeys(a.note.closeKeys, b.note.closeKeys));
}

export interface DialogEditorObservation {
  purpose: "answer" | "question-note" | "global-note";
  layout: "inline" | "boxed";
  /** Question/step identity, independent of the editor's caret and value. */
  ownerSignature: string;
  /** Current non-editor chrome/choices/styles, stable across caret moves but not a successor. */
  contextSignature: string;
  regionSignature: string;
  styledSignature?: string;
  /** Visible row text, without the input prefix; wrapping is not a logical newline. */
  rows: string[];
  /** UTF-16 offset within rows[row], not a display-column coordinate. */
  cursor: { row: number; offset: number; cell: string };
  /** Measured input bindings, not numeric shortcuts inferred from the menu. */
  keys: { start: string[]; end: string[]; up: string[]; left: string[]; right: string[] };
}

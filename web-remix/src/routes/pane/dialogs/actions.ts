// The writes of the wizard, multi-select and preview-select cards: the same guarded modules the React
// app writes through (web/src/lib/wizard-action.ts, multi-select-action.ts, preview-action.ts),
// called unchanged. Each tap is ONE verified keystroke, or the module's own closed-loop choreography
// (ADR 0080); nothing here re-parses a screen or picks a key. This file only maps the outcome to the
// status line (web/src/components/agent-chat.tsx `handleWizardAction`, `handlePreviewAction`,
// `handleMultiSelectAction`), starts the poll burst, and waits for the repaint before the card
// answers again.
//
// Shape and PAIRING follow `../answer.ts` (`answerOption`): a write that went through is the proof of
// pairing, so it goes to this shell's latch as the 2xx it was. The status goes to the app's one
// channel (`lib/status.ts`).
import type { MultiSelectModel, PreviewOption, PreviewSelectModel, WizardModel } from "@web/lib/blocks";
import { settleAfterSend, type ActionResult } from "@web/lib/harness/guard";
import { t } from "@web/lib/i18n";
import { submitMultiSelectIntent, type MultiSelectIntent } from "@web/lib/multi-select-action";
import { submitPreviewKeys, submitPreviewNote, submitPreviewOption } from "@web/lib/preview-action";
import { submitWizardKeys } from "@web/lib/wizard-action";

import { notePairing } from "../../../lib/pairing";
import { kick, noteSend } from "../../../lib/polling";
import { setStatus } from "../../../lib/status";
import type { WriteTarget } from "../answer";
import { PANE_LINES } from "../data";

/** One tap's intent on a preview-select card, resolved to keystrokes by web's preview-action. */
export type PreviewCardAction =
  | { kind: "option"; option: PreviewOption }
  /** `text` of "" removes the note. */
  | { kind: "note"; text: string }
  | { kind: "nav"; keys: string[] };

/** What every guarded tap carries: which pane, which read the card came from, which adapter. */
function guardArgs(target: WriteTarget) {
  return {
    paneId: target.paneId,
    scope: target.scope,
    requestedLines: target.lines ?? PANE_LINES,
    detectedRevision: target.revision,
    agent: target.agent,
  };
}

/** After a tap that SENT: wait for the TUI to repaint, then poll, so the card is not left stale. */
async function showAfterSend(target: WriteTarget): Promise<void> {
  await settleAfterSend({ paneId: target.paneId, requestedLines: target.lines ?? PANE_LINES, scope: target.scope });
  kick();
}

function refuse(target: WriteTarget): boolean {
  if (target.refusal === undefined) return false;
  setStatus(target.refusal, "error");
  return true;
}

/**
 * Map a guarded tap's outcome to the status line, the burst and the repaint wait. `sent` and
 * `changed` are the status words; an `error` repolls too when `repollOnError` (the preview card's
 * multi-step choreography can leave the dialog moved, as in `handlePreviewAction`).
 */
async function report(
  target: WriteTarget,
  result: ActionResult,
  sent: string,
  changed: string,
  repollOnError = false,
): Promise<boolean> {
  if (result.status === "sent") {
    notePairing("POST", 200);
    setStatus(sent, "success");
    await showAfterSend(target);
    return true;
  }
  if (result.status === "changed") {
    // Which step refused, for a person with the console open; never UI text.
    if (result.why !== undefined) console.info("collie: tap refused", result.why);
    setStatus(changed, "warn");
    kick();
    return false;
  }
  setStatus(result.error || t("chat.status.sendFailed"), "error");
  if (repollOnError) kick();
  return false;
}

/** Tap a wizard control: an option digit, step navigation, or the review step's submit and cancel. */
export async function answerWizard(target: WriteTarget, wizard: WizardModel, keys: string[]): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await submitWizardKeys({ ...guardArgs(target), wizard, keys });
  return report(target, result, t("chat.status.sent"), t("chat.status.wizardChanged"));
}

/** Tap a multi-select control: a checkbox, Submit, the escape row, or the review screen's controls. */
export async function answerMultiSelect(
  target: WriteTarget,
  multi: MultiSelectModel,
  intent: MultiSelectIntent,
): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await submitMultiSelectIntent({ ...guardArgs(target), multi, intent });
  return report(target, result, t("chat.status.sent"), t("chat.status.selectionChanged"));
}

/** Tap a preview-select control: an option, the note (add, edit, remove), or the step navigation. */
export async function answerPreview(
  target: WriteTarget,
  preview: PreviewSelectModel,
  action: PreviewCardAction,
): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const base = { ...guardArgs(target), preview };
  const result =
    action.kind === "option"
      ? await submitPreviewOption({ ...base, option: action.option })
      : action.kind === "note"
        ? await submitPreviewNote({ ...base, text: action.text })
        : await submitPreviewKeys({ ...base, keys: action.keys });
  const sent =
    action.kind === "note"
      ? action.text
        ? t("chat.status.noteSaved")
        : t("chat.status.noteRemoved")
      : t("chat.status.sent");
  return report(target, result, sent, t("chat.status.dialogChanged"), true);
}

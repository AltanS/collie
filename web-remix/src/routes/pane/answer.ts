// Every write the pane screen makes, through the SAME modules the React app writes through.
//
// The dialog taps call web/src/lib/prompt-action.ts, menu-action.ts and dialog-guard.ts unchanged;
// the reply calls web/src/lib/reply-action.ts; the keys row calls web/src/lib/api.ts `sendKeys`. Those
// modules own the race guard (fresh read, revision check, re-derivation through the pane's adapter),
// the region binding the bridge re-checks before it writes (`expected_prompt`), ADR 0080's walk,
// verify, commit for pointed lists, and the reply's type-then-verify. Nothing here re-parses a
// screen or picks a key; this file only maps their outcomes to the status line, starts the poll
// burst (`noteSend`), and waits for the terminal to repaint before the card is tappable again.
//
// PAIRING. web's api.ts reads every write's answer into web's latch; pane.tsx carries a refusal from
// there into this shell's latch. A write that went through is the proof of the opposite, so each
// one also goes to this shell's `notePairing` as the 2xx it was.
import { sendKeys } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import type { MenuModel, PromptModel, PromptOption, UnreadDialogModel } from "@web/lib/blocks";
import { sendGuardedKeys } from "@web/lib/dialog-guard";
import { settleAfterSend, type ActionResult } from "@web/lib/harness/guard";
import { t } from "@web/lib/i18n";
import { submitMenuKeys } from "@web/lib/menu-action";
import { submitPromptFeedback, submitPromptOption } from "@web/lib/prompt-action";
import { sendGuardedReply, type GuardedReplyArgs, type ReplyOutcome } from "@web/lib/reply-action";
import type { Scope } from "@web/lib/scope";

import { notePairing } from "../../lib/pairing";
import { kick, noteSend } from "../../lib/polling";
import { PANE_LINES } from "./data";
import { setPaneStatus } from "./status";

/** Where a write goes and what screen it was decided on. */
export interface WriteTarget {
  paneId: string;
  scope: Scope;
  /** The pane's agent string from the snapshot: which adapter re-derives the fresh screen. */
  agent: string | undefined;
  /** The `revision` of the read the card was drawn from. */
  revision: number;
  /** Why the pane refuses a write right now, or undefined when it takes one. */
  refusal: string | undefined;
  /** The window the mirror was read with (it grows with Load older); the guard re-reads the same. */
  lines?: number;
}

/** After a tap that SENT: wait for the TUI to repaint, then poll, so the card is not left stale. */
async function showAfterSend(target: WriteTarget): Promise<void> {
  await settleAfterSend({ paneId: target.paneId, requestedLines: target.lines ?? PANE_LINES, scope: target.scope });
  kick();
}

/** Map a guarded tap's outcome to the status line, the burst and the repaint wait. */
async function reportTap(target: WriteTarget, result: ActionResult, sent: string, changed: string): Promise<boolean> {
  if (result.status === "sent") {
    notePairing("POST", 200);
    setPaneStatus(sent, "success");
    await showAfterSend(target);
    return true;
  }
  if (result.status === "changed") {
    // Which step refused, for a person with the console open; never UI text.
    if (result.why !== undefined) console.info("collie: tap refused", result.why);
    setPaneStatus(changed, "warn");
    kick();
    return false;
  }
  setPaneStatus(result.error || t("chat.status.sendFailed"), "error");
  return false;
}

function refuse(target: WriteTarget): boolean {
  if (target.refusal === undefined) return false;
  setPaneStatus(target.refusal, "error");
  return true;
}

/** What every guarded tap carries: which pane, which read the card came from, which adapter. */
interface GuardArgs {
  paneId: string;
  scope: Scope;
  requestedLines: number;
  detectedRevision: number;
  agent: string | undefined;
}

function guardArgs(target: WriteTarget): GuardArgs {
  return {
    paneId: target.paneId,
    scope: target.scope,
    requestedLines: target.lines ?? PANE_LINES,
    detectedRevision: target.revision,
    agent: target.agent,
  };
}

/** Tap one option of a single-choice dialog. A pointed list walks, verifies, then commits (ADR 0080). */
export async function answerOption(target: WriteTarget, prompt: PromptModel, option: PromptOption): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await submitPromptOption({ ...guardArgs(target), prompt, option });
  return reportTap(target, result, t("chat.status.sent"), t("chat.status.menuChanged"));
}

/** Send a plan's feedback: digit, verify focus, type, verify the words, then Enter. */
export async function answerFeedback(target: WriteTarget, prompt: PromptModel, text: string): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await submitPromptFeedback({ ...guardArgs(target), prompt, text });
  return reportTap(target, result, t("chat.status.feedbackSent"), t("chat.status.menuChanged"));
}

/** Tap a generic menu's control. Arrows (`nav`) take the identity-only guard. */
export async function answerMenu(target: WriteTarget, menu: MenuModel, keys: string[], nav: boolean): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await submitMenuKeys({ ...guardArgs(target), menu, keys, nav });
  return reportTap(target, result, t("chat.status.sent"), t("chat.status.screenChanged"));
}

/** The unread-dialog card's one declared key (ADR 0053), through the same guard. */
export async function answerUnread(target: WriteTarget, cancel: UnreadDialogModel): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  const result = await sendGuardedKeys({ ...guardArgs(target), kind: "unread-dialog", model: cancel }, [cancel.key]);
  return reportTap(target, result, t("chat.status.sent"), t("chat.status.screenChanged"));
}

/** One special key from the keys row: unguarded, as the Keys tray sends it. */
export async function pressKeys(target: WriteTarget, keys: string[]): Promise<boolean> {
  if (refuse(target)) return false;
  noteSend(target.paneId);
  try {
    const res = await sendKeys(target.paneId, keys, target.scope);
    if (!res.ok) {
      setPaneStatus(describeApiError(res), "error");
      return false;
    }
    notePairing("POST", 200);
    kick();
    return true;
  } catch (error) {
    setPaneStatus(describeThrownError(error), "error");
    return false;
  }
}

/** Send a typed reply: pre-flight, type, verify the words reached the input box, then submit. */
export async function sendTypedReply(
  target: WriteTarget,
  text: string,
  force: boolean,
  onComposerSeen?: GuardedReplyArgs["onComposerSeen"],
): Promise<ReplyOutcome> {
  if (target.refusal !== undefined) return { status: "blocked", error: target.refusal };
  noteSend(target.paneId);
  try {
    const outcome = await sendGuardedReply({
      paneId: target.paneId,
      text,
      agent: target.agent,
      scope: target.scope,
      requestedLines: target.lines ?? PANE_LINES,
      force,
      onComposerSeen,
    });
    if (outcome.status === "sent") notePairing("POST", 200);
    kick();
    return outcome;
  } catch (error) {
    return { status: "error", error: describeThrownError(error) };
  }
}

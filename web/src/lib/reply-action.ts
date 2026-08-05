// The free-text reply path's race guard.
//
// Every OTHER path that types into a live TUI (prompt-, wizard-, preview-action) refuses to send a
// key it hasn't first verified the pane is ready for — "Enter is never sent blind". The reply path
// was the one exception: it typed the text, waited a fixed 350ms, and fired the submit key with
// nothing checking what was on screen.
//
// That is issue #34, reproduced on a real pane: with a Claude permission dialog focused, the typed
// text is swallowed and the submit key ANSWERS THE DIALOG — approving whatever option was
// highlighted (Claude highlights "Yes" by default). The message is destroyed and the bridge still
// reports {ok:true}, because both Herdr RPCs genuinely succeeded: an ack means "herdr took the
// bytes" (HERDR_API.md), never "the TUI acted on them". So the bridge cannot detect this; only a
// client that can read the input box can.
//
// The fix makes the submit key CONDITIONAL on evidence the text reached the input box: type
// unsubmitted → poll fresh reads until the adapter sees our text on the "❯" line → only then
// submit. If it never appears, NO key is sent and the caller keeps the draft. This is the same
// choreography submitPreviewNote already uses for the note field, applied to the main input.

import { fetchPane, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { adapterFor } from "./harness";
import { POLL_ATTEMPTS, POLL_DELAY_MS, defaultSleep, type Sleep } from "./harness/guard";

export type ReplyOutcome =
  /** Text was verified in the input box and the submit key went through. */
  | { status: "sent" }
  /**
   * The PRE-FLIGHT refused: the adapter could not see an input box on screen, so NOTHING was typed
   * and no key was sent. Distinct from `stalled`, which is reported only after the text has already
   * gone into the pane. The caller keeps the draft and may offer a deliberate override (`force`).
   */
  | { status: "blocked"; error: string }
  /** Text never reached the input box — NO submit key was sent. The caller MUST keep the draft. */
  | { status: "stalled"; error: string }
  /** Transport/RPC failure. `textDelivered` = text is in the pane but unsubmitted; don't resend. */
  | { status: "error"; error: string; textDelivered?: boolean };

/** Minimum visible characters that must match before we believe the input box holds OUR text. */
export const MIN_MATCH_CHARS = 8;

/** extractInputDraft space-joins a wrapped draft, so compare on collapsed whitespace. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Whether the input box's visible draft is evidence that `sent` landed there. The box WINDOWS a long
 * draft and folds its wrapped lines with spaces, so exact equality is too strict — requiring the
 * visible draft to be a contiguous slice of what we typed is the strongest claim that survives
 * windowing. The length floor stops a short unrelated remnant ("y", "n", a placeholder) from passing
 * as a match; for a send shorter than the floor, the whole thing must be there.
 */
export function draftCarriesSend(sent: string, draft: string | null): boolean {
  if (draft === null) return false;
  const s = collapse(sent);
  const d = collapse(draft);
  if (d.length === 0) return false;
  return s.includes(d) && d.length >= Math.min(s.length, MIN_MATCH_CHARS);
}

export interface GuardedReplyArgs {
  paneId: string;
  text: string;
  /** The pane's agent — picks the adapter whose `extractInputDraft` can read the input box. */
  agent: string | undefined | null;
  /** The session the pane lives in (undefined = primary) — scopes every call. */
  session?: string;
  /** Lines to request per verification read (undefined = the bridge's default tail, which is where
   *  the input box always is). */
  requestedLines?: number;
  /** Test seam for the poll pacing. */
  sleep?: Sleep;
  /**
   * Skip the PRE-FLIGHT and type anyway — the user's deliberate second tap after a `blocked`
   * outcome (a mis-detected screen, an adapter that can't see a box it really has). It skips ONLY
   * the pre-flight: the type-then-verify guard below still runs, so the submit key is never fired
   * blind even under an override.
   */
  force?: boolean;
}

export async function sendGuardedReply(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  const adapter = adapterFor(args.agent ?? undefined);
  // No grammar for this harness → the input box is unreadable, so there is nothing to verify
  // against and the guard cannot run. Keep the legacy one-shot send rather than guess: a heuristic
  // over the raw mirror has a false-negative that is worse than the bug — a no-echo input (a shell's
  // sudo prompt) would never show the text, so the submit key would be withheld forever. Non-Claude
  // harnesses gain this safety exactly when they gain an adapter.
  if (!adapter) return oneShot(args);

  // PRE-FLIGHT. The verify-after guard below is enough to keep Enter from answering a dialog, but it
  // is not enough to keep the MESSAGE out of one: it types first and checks second, so a modal that
  // owns the keyboard (Claude's `/model` picker — no input box at the tail at all) receives the
  // user's text before anything notices. One read up front is the difference between "nothing
  // happened" and "your reply is now sitting in a picker".
  //
  // Adapter-scoped and fail-OPEN in both weak directions: an adapter without `composerReady` keeps
  // today's behaviour, and a read that throws falls through to the guard rather than blocking a send
  // on a transient network blip. Only a definite `false` refuses.
  if (adapter.composerReady && !args.force) {
    try {
      const probe = await fetchPane(args.paneId, args.requestedLines, args.session);
      if (!adapter.composerReady(splitLines(parseAnsi(probe.text)))) {
        return {
          status: "blocked",
          error:
            "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.",
        };
      }
    } catch {
      // Transient read failure: fall through. The type-then-verify guard still protects the submit key.
    }
  }

  let typed;
  try {
    typed = await sendReply(args.paneId, args.text, false, args.session);
  } catch (e) {
    return { status: "error", error: message(e) };
  }
  if (!typed.ok) return { status: "error", error: typed.error };

  const sleep = args.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    // Read BEFORE the first sleep: pane.read is an on-demand live read, not a cached poll, so the
    // text is often already on screen by the time the type call returns. That saves a whole
    // POLL_DELAY_MS off the common path — the old blind flow always paid a fixed 350ms here.
    if (attempt > 0) await sleep(POLL_DELAY_MS);
    let draft: string | null = null;
    try {
      const fresh = await fetchPane(args.paneId, args.requestedLines, args.session);
      draft = adapter.extractInputDraft(splitLines(parseAnsi(fresh.text)));
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (draftCarriesSend(args.text, draft)) return submitOnly(args);
  }

  // The text never showed up on the input line. The likeliest cause is a dialog holding focus and
  // eating the keystrokes — and the one thing we must NOT do is send the submit key anyway, because
  // that is precisely what answers the dialog. Stop dead and let the caller keep the draft.
  //
  // If instead this is a false negative (the text IS in the box, the adapter just couldn't see it),
  // nothing is lost: the next send's pre-clear sweep removes it, and the stranded-draft preview
  // surfaces it in the meantime.
  return {
    status: "stalled",
    error:
      "Message didn't reach the input box — a dialog may be waiting, and if you were answering it by key that key likely landed. Nothing was submitted.",
  };
}

/** The pre-#34 behaviour: one call that types AND submits. Only for harnesses with no adapter. */
async function oneShot(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  try {
    const res = await sendReply(args.paneId, args.text, true, args.session);
    return res.ok ? { status: "sent" } : { status: "error", error: res.error };
  } catch (e) {
    return { status: "error", error: message(e) };
  }
}

/**
 * Empty text + submit: `sendReplySteps` skips the send_text step entirely and sends ONLY the
 * bridge's configured submit keys (COLLIE_SUBMIT_KEYS). So the submit-key contract stays
 * server-owned and this whole guard needs no bridge change.
 */
async function submitOnly(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  try {
    const res = await sendReply(args.paneId, "", true, args.session);
    if (res.ok) return { status: "sent" };
    // The text is verifiably sitting in the input box and only the submit key failed — same shape as
    // the bridge's own partial-failure case. Tell the caller not to resend.
    return {
      status: "error",
      error: "typed into the pane but not submitted — check the pane before resending",
      textDelivered: true,
    };
  } catch (e) {
    return { status: "error", error: message(e), textDelivered: true };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

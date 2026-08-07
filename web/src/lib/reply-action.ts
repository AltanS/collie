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
import type { Scope } from "./scope";

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

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/** The exact gap extractInputDraft's fold inserts at a wrap seam: one plain space, always. Any
 *  other gap on screen is whitespace the operator really typed, so `sent` must carry it too. */
const FOLD_SEAM = " ";

/** `Intl.Segmenter` is the newest platform API anything in this bundle depends on (Firefox 125,
 *  Safari 14.1), and this module is in the main chunk — composer.tsx imports it eagerly, so a
 *  module-scope `new Intl.Segmenter` on an engine without it throws at evaluation and white-screens
 *  the whole PWA at boot. Feature-detect instead: an unsupported engine must lose grapheme
 *  precision, never the app. The `null` branches below fall back to per-code-point counting, which
 *  is exactly what this check did before clusters were understood at all — a match that stops mid
 *  cluster slips through there, as it always did. */
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** A cluster nobody can see: whitespace, or formatting controls that render as nothing at all
 *  (LRM/RLM, zero-width space, soft hyphen). A cluster that merely CONTAINS one still counts — the
 *  ZWJ inside a family emoji is joining visible characters, not standing in for them. */
const UNREADABLE = /^[\s\p{Default_Ignorable_Code_Point}]+$/u;

/** Visible characters. The floor below is a claim about how much of the message is legible on
 *  screen, so it must count what a reader counts — one emoji is one character, not the 11 UTF-16
 *  code units a ZWJ family sequence happens to occupy, and an invisible control is not a character
 *  at all however many of them are threaded through the text.
 *
 *  Segmenting the string AS GIVEN matters: stripping its spaces first can fuse the neighbours into
 *  one cluster. "🇯 🇵" is two characters, but strip the space and the regional indicators pair into
 *  the single flag "🇯🇵" — one character, and a floor half as high as it should be. */
function visibleLength(s: string): number {
  let n = 0;
  if (GRAPHEMES === null) {
    // Code points, not code units — a lone surrogate half is never a character on any engine.
    for (const ch of s) if (!UNREADABLE.test(ch)) n += 1;
    return n;
  }
  for (const segment of GRAPHEMES.segment(s)) if (!UNREADABLE.test(segment.segment)) n += 1;
  return n;
}

/** Every offset in `s` where one visible character ends and the next begins, plus both ends. A match
 *  that starts or stops anywhere else has sliced a character in half — "👩‍👧‍👦" is a code-unit
 *  substring of "👨‍👩‍👧‍👦", but it is a DIFFERENT character and must not verify as that one. */
function characterBoundaries(s: string): Set<number> {
  const bounds = new Set<number>([s.length]);
  if (GRAPHEMES === null) {
    let i = 0;
    for (const ch of s) {
      bounds.add(i);
      i += ch.length;
    }
    return bounds;
  }
  for (const segment of GRAPHEMES.segment(s)) bounds.add(segment.index);
  return bounds;
}

/**
 * Whether the input box's visible draft is evidence that `sent` landed there. The box WINDOWS a long
 * draft (only its tail is on screen) and FOLDS its wrapped lines together with a space, so exact
 * equality is too strict — the strongest claim that survives both is that the draft's visible
 * characters appear contiguously in what we typed.
 *
 * The fold is the subtle part. extractInputDraft joins the box's visual lines with a space, which
 * restores a REAL space only when the box happened to wrap at a word boundary; wrapping mid-run (CJK
 * has no spaces to break at) fabricates a space the sent text never had. The joined string cannot
 * say which kind each of its spaces is, and one string can hold both — "これは pull request です"
 * wrapped mid-CJK has a genuine space AND a fabricated one. So the ambiguity is per-SEAM, not
 * per-string, and no language test can resolve it.
 *
 * Hence: split the draft on whitespace and require its non-space runs to appear in `sent` in order,
 * with only whitespace between them. Every visible character still has to be there, contiguously and
 * in order — only the WIDTH of a gap the fold could have produced is treated as unknowable, which is
 * exactly what the fold destroyed. A draft that dropped or altered a non-space character still fails.
 *
 * Only a gap spelled exactly like the fold's own seam (one plain space) may collapse to nothing, and
 * only that gap is loosened at all. Any other gap — a run of spaces, a tab, an ideographic space —
 * is whitespace the terminal actually rendered, so `sent` must carry that same whitespace verbatim.
 * Without the distinction the guard would accept a screen holding "危険　実行" for a send of
 * "危険実行", or "delete　file" for "delete file": different messages, both authorised.
 *
 * The match must also land on visible-character boundaries, because a code-unit substring can cut a
 * character in half — "👩‍👧‍👦" sits inside "👨‍👩‍👧‍👦" without being it.
 *
 * The length floor stops a short unrelated remnant ("y", "n", a placeholder) from passing as a
 * match; for a send shorter than the floor, the whole thing must be there. It counts non-space
 * characters, since spaces are the part we just agreed not to trust.
 */
export function draftCarriesSend(sent: string, draft: string | null): boolean {
  if (draft === null) return false;
  // Odd indices are the gaps, even indices the runs — the gaps decide how strict each seam is.
  const parts = draft.trim().split(/(\s+)/);
  const runs = parts.filter((_part, i) => i % 2 === 0);
  const gaps = parts.filter((_part, i) => i % 2 === 1);
  if (runs.length === 0 || runs[0]!.length === 0) return false;

  const visible = runs.reduce((n, run) => n + visibleLength(run), 0);
  if (visible < Math.min(visibleLength(sent), MIN_MATCH_CHARS)) return false;

  // Runs are whitespace-free by construction, so the joined pattern can never nest quantifiers.
  const escape = (s: string) => s.replace(REGEXP_META, "\\$&");
  let pattern = escape(runs[0]!);
  for (let i = 1; i < runs.length; i++) {
    const gap = gaps[i - 1]!;
    pattern += (gap === FOLD_SEAM ? "\\s*" : escape(gap)) + escape(runs[i]!);
  }

  // Every occurrence gets its own boundary check, not just the first: an earlier hit that happens to
  // stop mid-character must not mask a later, properly aligned one. Rewinding to one past the hit's
  // start (rather than to its end) keeps overlapping occurrences reachable.
  const scan = new RegExp(pattern, "g");
  const bounds = characterBoundaries(sent);
  for (let hit = scan.exec(sent); hit !== null; hit = scan.exec(sent)) {
    if (bounds.has(hit.index) && bounds.has(hit.index + hit[0].length)) return true;
    scan.lastIndex = hit.index + 1;
  }
  return false;
}

export interface GuardedReplyArgs {
  paneId: string;
  text: string;
  /** The pane's agent — picks the adapter whose `extractInputDraft` can read the input box. */
  agent: string | undefined | null;
  /** Which machine + which named session the pane lives in — scopes every call. */
  scope?: Scope;
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
      const probe = await fetchPane(args.paneId, args.requestedLines, args.scope);
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
    typed = await sendReply(args.paneId, args.text, false, args.scope);
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
      const fresh = await fetchPane(args.paneId, args.requestedLines, args.scope);
      draft = adapter.extractInputDraft(splitLines(parseAnsi(fresh.text)));
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (draftCarriesSend(args.text, draft)) return submitOnly(args);
    // The adapter gets a second look, and only a second look: a harness can SWALLOW what we typed and
    // paint a token of its own instead (Claude collapses anything past its paste threshold into
    // `[Pasted text #N +M lines]`), so the box never holds our words and the match above structurally
    // cannot succeed — the send stalls forever while every retry re-collapses. The adapter is the only
    // thing that knows its harness's token and whether this one is consistent with THIS send
    // (.adr/0010). It can only widen the evidence, never narrow it, so a harness without the
    // capability is untouched.
    if (draft !== null && adapter.draftCarriesSend?.(args.text, draft)) return submitOnly(args);
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
    const res = await sendReply(args.paneId, args.text, true, args.scope);
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
    const res = await sendReply(args.paneId, "", true, args.scope);
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

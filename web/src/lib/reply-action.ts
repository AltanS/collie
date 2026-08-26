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
import { adapterFor, type HarnessAdapter } from "./harness";
import { CODEX_CHUNK_SETTLE_MS, codexInputChunks } from "./harness/codex/paste";
import { POLL_ATTEMPTS, POLL_DELAY_MS, defaultSleep, type Sleep } from "./harness/guard";
import { detectNoEchoPrompt } from "./no-echo";

export type ReplyOutcome =
  /** Text was verified in the input box and the submit key went through. */
  | { status: "sent" }
  /**
   * The PRE-FLIGHT refused: a live read could not see an input box on screen, so NO REPLY TEXT was
   * typed and no submit key was sent. Distinct from `stalled`, which is reported only after the text
   * has already gone into the pane. The caller keeps the draft and may offer a deliberate override
   * (`force`). The caller's `onComposerSeen` work may have run before a re-confirming refusal — but
   * only ever on the path where a live read had just seen the composer, which is the invariant that
   * whole callback exists to enforce.
   *
   * `noEcho` carries the password prompt the refusing read was looking at, when it was one — see
   * lib/no-echo.ts.
   */
  | { status: "blocked"; error: string; noEcho?: string }
  /** Text never reached the input box — NO submit key was sent. The caller MUST keep the draft.
   *  `noEcho`: the prompt the last verification read saw, when the reason the text never appeared is
   *  that the screen is deliberately not showing it — see lib/no-echo.ts. */
  | { status: "stalled"; error: string; noEcho?: string }
  /** Transport/RPC failure. `textDelivered` = text is in the pane but unsubmitted; don't resend. */
  | { status: "error"; error: string; textDelivered?: boolean };

/** Minimum visible characters that must match before we believe the input box holds OUR text. */
export const MIN_MATCH_CHARS = 8;
const CODEX_POLL_ATTEMPTS = 16;

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
  /** The session the pane lives in (undefined = primary) — scopes every call. */
  session?: string;
  /** Lines to request per verification read (undefined = the bridge's default tail, which is where
   *  the input box always is). */
  requestedLines?: number;
  /** Test seam for the poll pacing. */
  sleep?: Sleep;
  /**
   * Override the PRE-FLIGHT'S REFUSAL and type anyway — the user's deliberate second tap after a
   * `blocked` outcome (a mis-detected screen, an adapter that can't see a box it really has). The
   * live read still happens; `force` only stops a definite `false` from refusing the send. The
   * type-then-verify guard below still runs, so the submit key is never fired blind either way, and
   * `onComposerSeen` still does not run — a screen that just answered "no composer" is the last
   * place destructive keys may go.
   */
  force?: boolean;
  /**
   * Work the caller needs done once a live read has POSITIVELY SEEN the composer, and before the
   * first byte of the reply is typed. Exists for exactly one caller and one reason: composer.tsx's
   * pre-clear sweep (`ctrl+k` + a run of Backspaces that wipes a stranded draft off the input line so
   * `pane.send_text` doesn't append to it) is DESTRUCTIVE, and it used to run in the composer before
   * `sendGuardedReply` was called at all — i.e. before anything had looked at the live pane.
   *
   * That ordering is the whole bug. The composer decides to sweep from `display`, which is a
   * SNAPSHOT: a poll behind while the mirror follows the tail, and frozen outright while the user has
   * scrolled back or opened find. So its own fail-fast (`dialogPresent`) can read false against a pane
   * that has since put a dialog up, and the sweep then fires into that dialog — the exact
   * keystrokes-into-a-modal failure #34 is about, just upstream of where #34 was fixed.
   *
   * For an adapter that lifts NO interactive kind that fail-fast is not merely stale, it is inert:
   * `dialogPresent` is `buildBlocks(...).some(b => b.kind !== "raw")`, so an adapter whose
   * `buildBlocks` returns one `raw` block by construction can never make it true. Verified live
   * against an omp pane with a full-screen picker up: `dialogPresent === false`. There is no window
   * to widen or narrow there — `composerReady` is the ONLY gate on such a pane, which is why this
   * hook keys on it rather than on the caller having already checked something.
   *
   * The name is the contract: this runs ONLY on the branch where `composerReady` answered true about
   * a pane read moments ago. `force`, a read that threw, an adapter with no `composerReady`, no
   * adapter at all — none of them reaches it, and neither will whatever path is added next, because
   * `preflight` hands the runner back only on that one branch (see `Preflight`). Every other path
   * types without sweeping and leans on type-then-verify, which still withholds the submit key.
   *
   * Resolving `{ ok: false }` aborts the send with that error and nothing typed. `keysSent` says
   * whether anything actually reached the pane: when it did, the pre-flight's evidence is stale and
   * the guard re-confirms before typing.
   *
   * The argument carries the evidence FORWARD, not just the permission. `promptRegion` is the prompt
   * tail the adapter saw on the pane the pre-flight just read, and a caller that sends destructive
   * keys must pass it to `api.sendKeys` as `expected_prompt`: an ordering guarantee alone cannot
   * bound the gap between the read and the keys, because that gap is a network round-trip and the
   * only limit on it is GET_TIMEOUT_MS. Binding hands the last word to the bridge, which re-reads
   * immediately before `send_keys` and 409s the write if the row has gone — the same mitigation
   * every dialog tap already gets through lib/dialog-guard.ts.
   */
  onComposerSeen?: (seen: ComposerSeen) => Promise<ComposerPrepResult>;
}

/** What the pre-flight's live read saw, handed to the caller's pre-type work. */
export interface ComposerSeen {
  /**
   * The composer's own prompt/draft tail, verbatim on screen, for binding a destructive write to it
   * (`api.sendKeys(..., expectedPrompt)`). `null` when the adapter has no `composerPrompt` — then the
   * write goes out unbound, which is the pre-existing behaviour and the reason the hook is optional.
   */
  promptRegion: string | null;
}

export type ComposerPrepResult =
  /** Done. `keysSent` = did anything actually go out on the wire? A caller with nothing to do says
   *  `false` and saves the guard a re-confirming read. */
  | { ok: true; keysSent: boolean }
  /** Abort the send with this error, nothing typed. */
  | { ok: false; error: string };

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
  const { refuse, runPreType } = await preflight(adapter, args);
  if (refuse !== null) return refuse;

  // The ONE call site of the caller's destructive pre-type work — and it is not guarded by a
  // condition, it is guarded by whether the runner exists at all. `preflight` returns one only from
  // the branch where a live read just saw the composer, so every other path (force, a read that
  // threw, an adapter with no `composerReady`, and anything added later) skips this by construction
  // rather than by remembering to check. `?.()` is the whole enforcement; there is no list to keep
  // in sync.
  const aborted = await runPreType?.();
  if (aborted) return aborted;

  const sleep = args.sleep ?? defaultSleep;
  const chunks = adapter.agent === "codex" ? codexInputChunks(args.text) : [args.text];
  let textDelivered = false;
  for (let index = 0; index < chunks.length; index++) {
    let typed;
    try {
      typed = await sendReply(args.paneId, chunks[index]!, false, args.session);
    } catch (e) {
      return {
        status: "error",
        error: message(e),
        ...(textDelivered ? { textDelivered: true } : {}),
      };
    }
    if (!typed.ok) {
      const partial = textDelivered || typed.textDelivered === true;
      return {
        status: "error",
        error: typed.error,
        ...(partial ? { textDelivered: true } : {}),
      };
    }
    textDelivered = true;
    if (index + 1 < chunks.length) await sleep(CODEX_CHUNK_SETTLE_MS);
  }

  // The last screen a verification read actually saw, kept only so the stall below can be named. The
  // pre-flight catches almost every password prompt before a byte is typed, but not all of them: a
  // harness with no `composerReady`, and a `force` the operator armed against a mis-detected screen,
  // both arrive here having typed the secret into a prompt that will never echo it.
  let lastSeen: string | null = null;
  let stableCodexPrompt: string | undefined;
  const pollAttempts = adapter.agent === "codex" ? CODEX_POLL_ATTEMPTS : POLL_ATTEMPTS;
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    // Read BEFORE the first sleep: pane.read is an on-demand live read, not a cached poll, so the
    // text is often already on screen by the time the type call returns. That saves a whole
    // POLL_DELAY_MS off the common path — the old blind flow always paid a fixed 350ms here.
    if (attempt > 0) await sleep(POLL_DELAY_MS);
    let draft: string | null = null;
    let promptRegion: string | undefined;
    try {
      const fresh = await fetchPane(args.paneId, args.requestedLines, args.session);
      const lines = splitLines(parseAnsi(fresh.text));
      // Only a screen the adapter does NOT recognise as its composer can be a raw password prompt.
      // Without that gate a match on the tail is dangerous rather than merely wrong: the notice this
      // feeds tells the operator to press Enter in Type, so a stall that was really a dialog eating
      // the text — with an agent that happened to PRINT "Enter passphrase:" as its last line — would
      // have us advising the exact keystroke #34 exists to prevent. An adapter with no
      // `composerReady` cannot rule anything out, so it doesn't (`?? false`): that path is the
      // unguarded one either way, and it is where a bare shell's sudo prompt actually lives.
      const composerVisible = adapter.composerReady?.(lines) ?? false;
      lastSeen = composerVisible ? null : detectNoEchoPrompt(lines);
      draft = adapter.extractInputDraft(lines);
      promptRegion = adapter.composerPrompt?.(lines) ?? undefined;
    } catch {
      stableCodexPrompt = undefined;
      continue; // transient read failure — the bounded loop is the timeout
    }
    const submitPrompt = adapter.agent === "codex" ? promptRegion : undefined;
    // The adapter gets a second look, and only a second look: a harness can SWALLOW what we typed and
    // paint a token of its own instead (Claude collapses anything past its paste threshold into
    // `[Pasted text #N +M lines]`), so the box never holds our words and the generic match
    // structurally cannot succeed. Only that harness knows whether its token fits THIS send
    // (.adr/0010); the capability can widen evidence, never narrow it.
    const verified =
      draftCarriesSend(args.text, draft) ||
      (draft !== null && adapter.draftCarriesSend?.(args.text, draft) === true);
    if (verified) {
      if (adapter.agent !== "codex") return submitOnly(args, submitPrompt);
      // Codex can expose a matching windowed slice before its wrapped composer has finished
      // repainting. Binding Enter to that first transient layout races the bridge's immediate read
      // and returns prompt_changed even though the full draft arrived. Require two consecutive,
      // byte-identical prompt/draft regions. The second read is read-only; text is never retyped.
      if (submitPrompt !== undefined && submitPrompt === stableCodexPrompt) {
        return submitOnly(args, submitPrompt);
      }
      stableCodexPrompt = submitPrompt;
      continue;
    }
    stableCodexPrompt = undefined;
  }

  // The text never showed up on the input line. The likeliest cause is a dialog holding focus and
  // eating the keystrokes — and the one thing we must NOT do is send the submit key anyway, because
  // that is precisely what answers the dialog. Stop dead and let the caller keep the draft.
  //
  // If instead this is a false negative (the text IS in the box, the adapter just couldn't see it),
  // nothing is lost: the next send's pre-clear sweep removes it, and the stranded-draft preview
  // surfaces it in the meantime.
  if (lastSeen !== null) {
    // Typed into a prompt that will never show it. The text IS in the pane — unsubmitted, which for a
    // password means the operator needs one Enter, not a retry, and a retry would type a second copy.
    return {
      status: "stalled",
      error:
        "That's a password prompt — it shows nothing as you type, so the text can't be confirmed and nothing was submitted. What you typed is already in the pane.",
      noEcho: lastSeen,
    };
  }
  return {
    status: "stalled",
    error:
      "Message didn't reach the input box — a dialog may be waiting, and if you were answering it by key that key likely landed. Nothing was submitted.",
  };
}

const NO_BOX =
  "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.";

/** Said instead of {@link NO_BOX} when the screen is a password prompt. It names the mechanism rather
 *  than the symptom, because the operator's next move depends on knowing that waiting won't help. */
const NO_ECHO =
  "That's a password prompt — it shows nothing as you type, so Send can never confirm the text arrived. Nothing was typed.";

/**
 * What the pre-flight decided. Two fields, and the second is the safety invariant of this module made
 * structural rather than conditional:
 *
 *   `refuse`     — non-null ⇒ return it; the send is refused with no reply text typed.
 *   `runPreType` — non-null ⇒ a live read POSITIVELY SAW the composer, so the caller's destructive
 *                  pre-type work may run. It is created on exactly one branch below and nowhere else.
 *
 * The point of shipping the permission as a CALLABLE rather than a boolean is that there is nothing
 * for a later edit to re-derive, forget, or get subtly wrong: a new path through `preflight` that does
 * not positively confirm a composer cannot produce a runner, so it cannot fire a keystroke, whatever
 * its author intended. That is what the three holes the previous shape left open all had in common —
 * `force`, a read that threw, and an adapter with no `composerReady` each SKIPPED the read and then
 * ran the sweep anyway, because the sweep was gated on its own separate condition — "did the caller
 * hand me a callback?" — instead of on the evidence.
 */
interface Preflight {
  refuse: ReplyOutcome | null;
  runPreType: (() => Promise<ReplyOutcome | null>) | null;
}

/**
 * One live read, and everything the rest of the send is allowed to do with it.
 *
 * Fail-OPEN for the MESSAGE in both weak directions — an adapter without `composerReady` and a read
 * that throws both fall through to the type-then-verify guard rather than blocking a send on a
 * transient network blip — and fail-CLOSED for KEYS in every direction but one. Failing open for the
 * message is defensible: the submit key is still withheld until the text is seen. Extending that to a
 * `ctrl+k` + 40×Backspace burst is not, because those keys are not withheld by anything downstream —
 * once sent they have already landed in whatever owns the keyboard.
 */
async function preflight(adapter: HarnessAdapter, args: GuardedReplyArgs): Promise<Preflight> {
  const blind = (refuse: ReplyOutcome | null): Preflight => ({ refuse, runPreType: null });

  // Nothing here can read this harness's input box, so there is no evidence to be had — and no
  // refusal to make either. Same behaviour as before an adapter grows a `composerReady`, minus the
  // sweep, which had no business going out unverified.
  if (!adapter.composerReady) return blind(null);

  const composerReady = adapter.composerReady.bind(adapter);
  let probe;
  try {
    probe = await fetchPane(args.paneId, args.requestedLines, args.session);
  } catch {
    return blind(null); // transient read failure
  }
  const seen = splitLines(parseAnsi(probe.text));
  if (!composerReady(seen)) {
    // `force` is the user's deliberate "type anyway", so it overrides the refusal — but this is the
    // one screen we have POSITIVE evidence about, and what it says is "no composer". Keys stay home.
    if (args.force) return blind(null);
    // The refusal is already made; naming the screen only changes what the operator is told. A
    // password prompt is the one case where the generic "a menu or dialog is probably up" is not just
    // unhelpful but actively misleading — there is no dialog to answer and no amount of retrying will
    // ever work, because the evidence this guard needs is exactly what the prompt is refusing to show
    // (#103). Hand the prompt itself back so the caller can say so and offer "Type".
    const noEcho = detectNoEchoPrompt(seen);
    if (noEcho !== null) return blind({ status: "blocked", error: NO_ECHO, noEcho });
    return blind({ status: "blocked", error: NO_BOX });
  }

  // The region the read's `true` was true OF. Computed here, from the same parse `composerReady` just
  // answered about, so the caller cannot bind its keys to anything but the screen that authorised
  // them — and cannot forget to, since it arrives as the argument.
  const promptRegion = adapter.composerPrompt?.(seen) ?? null;

  return {
    refuse: null,
    runPreType: async () => {
      if (!args.onComposerSeen) return null;
      let prep;
      try {
        prep = await args.onComposerSeen({ promptRegion });
      } catch (e) {
        return { status: "error", error: message(e) };
      }
      if (!prep.ok) return { status: "error", error: prep.error };
      if (!prep.keysSent) return null; // the read above is still the freshest thing there is

      // The caller put keys on the wire and waited for the TUI to settle, so the evidence that
      // authorised them is now an RPC and a settle old. Re-confirm before the MESSAGE goes out —
      // otherwise this ordering, which exists to stop keys reaching a dialog, would hand the dialog
      // the reply instead. Still fail-open on a throw: the submit key is guarded downstream.
      try {
        const fresh = await fetchPane(args.paneId, args.requestedLines, args.session);
        if (composerReady(splitLines(parseAnsi(fresh.text)))) return null;
      } catch {
        return null;
      }
      return {
        status: "blocked",
        error:
          "The agent's input box left the screen while its input line was being cleared — a menu or dialog is probably up. Your message wasn't typed.",
      };
    },
  };
}

/** The pre-#34 behaviour: one call that types AND submits. Only for harnesses with no adapter. */
async function oneShot(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  // No `onComposerSeen` here, and none is possible: with no adapter nothing can read the input box,
  // so no live read can ever confirm a composer, and the invariant says the destructive sweep stays
  // home. It costs this path nothing — agent-chat derives the stranded draft through
  // `adapterFor(agent)?.extractInputDraft`, so a pane with no adapter has no draft to sweep and the
  // composer's callback was already a no-op here.
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
async function submitOnly(
  args: GuardedReplyArgs,
  expectedPrompt?: string,
): Promise<ReplyOutcome> {
  try {
    const res = await sendReply(args.paneId, "", true, args.session, expectedPrompt);
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

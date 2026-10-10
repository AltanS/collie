// Model-GENERIC race-guard machinery: the skeleton every dialog tap runs (fresh read → parse →
// re-derive → unconditional revision check → structural-equality check), parameterised on the model
// type M, its detector, and its equality function.
//
// Nothing here knows a harness OR a block kind — it is deliberately one layer below that. The layer
// that binds the three parameters is lib/dialog-guard.ts: it supplies the detector (the pane's own
// adapter, via the registry) and the comparator (the kind's contract, via harness/dialog-contract),
// and it is the only caller the action modules see. Keeping the mechanism here and the wiring there
// is what lets this file stay free of both the registry and the models.

import { fetchPane, textBeforeLastSend } from "../api";
import { describeThrownError } from "../api-error-message";
import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import type { Scope } from "../scope";

/**
 * The canonical result of a guarded action. `sent` = the keystrokes went through; `changed` = the
 * guard rejected the tap (the pane drifted underfoot) and the caller should refresh; `error` = a
 * transport/RPC failure the caller surfaces verbatim.
 *
 * `why` on `changed` is a diagnosis for a person with a console open, never UI text and never
 * translated: which step refused. `"entry"` (the entry guard), `"timeout"` (the awaited state never
 * came), `"vanished"` (the dialog was gone), `"drift: <field>"` (another dialog: the first field
 * `identityDiff` names), `"bridge"` (the bridge answered 409). Only the walked tap
 * (`prompt-action.ts`, `walkVerifyCommit`) fills it in today, the one flow whose refusal hid a
 * grammar defect; every other caller leaves it out, and the generic guard stays silent.
 */
export type ActionResult =
  | { status: "sent" }
  | { status: "changed"; why?: string }
  | { status: "error"; error: string };

/**
 * What {@link entryGuard} returns. Discriminated on `ok`, the same shape the bridge side uses for
 * `PromptBindingResult`, `ExpectedPrompt` and `PromptBindingCheck`, so both ends of this feature
 * read alike. The passing case carries its payload instead of borrowing a type that reads as a
 * failure, and no call site has to reason about truthiness to tell the two apart.
 */
export type GuardOutcome<M = unknown> =
  | { ok: true; region: string; styled?: string; model: M }
  | { ok: false; result: ActionResult };

/** Test seam for the verification polls' pacing. */
export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded verification polling between choreography steps (the TUI re-renders well under a
// second; ~3s total before we give up and refresh).
export const POLL_ATTEMPTS = 8;
export const POLL_DELAY_MS = 350;

/** Derive the on-screen dialog model from a fresh pane's styled lines (null = no dialog there). */
type Detect<M> = (lines: StyledLine[]) => M | null;
type RegionOf<M> = (model: M) => string;
/** The canonical styled lines a model binds its write to, for a grammar whose pointer is a style. */
type StyledOf<M> = (model: M) => string | undefined;

/** One fresh read + re-derivation. Returns the model (null = no dialog on screen). */
export async function readModel<M>(
  paneId: string,
  requestedLines: number,
  scope: Scope | undefined,
  detect: Detect<M>,
): Promise<{ revision: number; model: M | null }> {
  const fresh = await fetchPane(paneId, requestedLines, scope);
  return { revision: fresh.revision, model: detect(splitLines(parseAnsi(fresh.text))) };
}

/**
 * The shared entry guard: a FRESH pane read, the UNCONDITIONAL revision check, and a full model
 * re-derivation compared (via `equals`) against `tapped` — what the user actually tapped.
 *
 * Returns a {@link GuardOutcome}: `{ ok: false, result }` when the guard refused (`"changed"`) or
 * the read failed, and `{ ok: true, region }` when it passed, carrying the verified region (via
 * `regionOf`) that the caller binds to its write, plus `styled` (via `styledOf`) when the model
 * carries a style-only state the bridge must bind as well (ADR 0080 point 7).
 *
 * The region the caller gets back is the one derived from THIS fresh read, so it describes the pane
 * as of a moment ago, not as of the render the user tapped. That is deliberate: the client guard has
 * already established the two are the same dialog, and the bridge needs the current text to find it.
 */
export async function entryGuard<M>(
  args: {
    paneId: string;
    requestedLines: number;
    /** The `revision` the rendered dialog was detected against. */
    detectedRevision: number;
    /** The session the pane lives in (undefined = primary) — scopes the read. */
    scope?: Scope;
  },
  tapped: M,
  detect: Detect<M>,
  equals: (a: M, b: M) => boolean,
  regionOf: RegionOf<M>,
  styledOf?: StyledOf<M>,
): Promise<GuardOutcome<M>> {
  let fresh;
  try {
    fresh = await readModel(args.paneId, args.requestedLines, args.scope, detect);
  } catch (e) {
    const error = describeThrownError(e);
    return { ok: false, result: { status: "error", error } };
  }

  // Revision check is UNCONDITIONAL: a 304 only means "unchanged since the last poll", and polls
  // keep advancing the ETag cache under a frozen mirror — it does NOT vouch for the snapshot the
  // user actually tapped on. The cached 304 body carries its revision, so this covers both paths.
  if (fresh.revision !== args.detectedRevision) return { ok: false, result: { status: "changed" } };
  // EMPIRICAL (Herdr 0.7.x, live-verified 2026-07-05): pane.read's `revision` is a stub upstream —
  // it is always 0, even for actively-changing panes. The gate above is therefore defense-in-depth
  // for future Herdr versions, NOT load-bearing. So the model re-derivation below runs on EVERY
  // path, including 304: the fresh (= latest cached) text is exactly what a tap on a possibly
  // frozen mirror must be compared against. One parse per tap — taps are rare, correctness isn't.
  if (!fresh.model || !equals(fresh.model, tapped)) {
    return { ok: false, result: { status: "changed" } };
  }
  const region = regionOf(fresh.model);
  const styled = styledOf?.(fresh.model);
  // Assigned, never conditionally spread: a model with no style-only state binds `region` alone.
  return styled === undefined
    ? { ok: true, region, model: fresh.model }
    : { ok: true, region, styled, model: fresh.model };
}

/**
 * What {@link pollUntil} hands back. `ok` carries the accepted fresh model and the `revision` of the
 * read it came from, so a caller that must bind a write to "the read that proved the state" needs no
 * second read. `drifted` carries the model whose identity failed, or none when the dialog was gone.
 */
export type PollOutcome<M> =
  | { status: "ok"; model: M; revision: number }
  | { status: "drifted"; model?: M }
  | { status: "timeout" };

/**
 * Poll (bounded) until `accept` passes on a fresh re-derivation. THREE-VALUED, because the caller
 * must distinguish "the awaited state never arrived, but this is still our dialog" from "a different
 * dialog is on screen now":
 *   - `"ok"`      — `accept` passed.
 *   - `"drifted"` — the dialog's IDENTITY changed: a fresh model whose `identity` no longer matches
 *                   `tapped` (a same-shaped successor / another dialog entirely), OR the dialog is
 *                   GONE (every read re-derived to null — e.g. the agent is running again). No
 *                   further key may be sent: a blind keystroke would hit whatever replaced it.
 *   - `"timeout"` — our dialog stayed on screen (identity intact) but the awaited state never came
 *                   within the bounded window (e.g. a swallowed keystroke). The dialog is still ours,
 *                   so a bounded RETRY of the same key is safe.
 * A transient null re-derivation MID-poll keeps polling (the TUI redraw can briefly hide the tail);
 * only an all-null poll (the dialog truly vanished) resolves to `"drifted"`, with no model.
 */
export async function pollUntil<M>(
  args: {
    paneId: string;
    requestedLines: number;
    /** Which machine + which named session the pane lives in — scopes every read. */
    scope?: Scope;
    /** Test seam for the poll pacing. */
    sleep?: Sleep;
  },
  tapped: M,
  detect: Detect<M>,
  accept: (m: M) => boolean,
  identity: (a: M, b: M) => boolean,
): Promise<PollOutcome<M>> {
  const sleep = args.sleep ?? defaultSleep;
  let sawDialog = false;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    let fresh;
    try {
      fresh = await readModel(args.paneId, args.requestedLines, args.scope, detect);
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (!fresh.model) continue; // transient redraw hid the tail — keep polling
    sawDialog = true;
    if (accept(fresh.model)) return { status: "ok", model: fresh.model, revision: fresh.revision };
    if (!identity(fresh.model, tapped)) return { status: "drifted", model: fresh.model }; // a different dialog now
  }
  // Exhausted. If we never saw the dialog at all it has vanished (a now-running agent) — treat as
  // drift, NOT a retryable timeout, so no blind key is sent at whatever replaced it.
  return sawDialog ? { status: "timeout" } : { status: "drifted" };
}

/** The gaps between the reads {@link settleAfterSend} makes. The first is short because the TUI
 *  repaints within tens of milliseconds of a key (measured 2026-10-04: about 19 ms), the rest widen
 *  because a slower repaint is rarer. They set the spacing only; the bound is
 *  {@link SETTLE_DEADLINE_MS}, and the gaps happen to sum to it. */
export const SETTLE_DELAYS_MS: readonly number[] = [60, 80, 120, 160, 240, 240, 300];

/** The wall-clock bound of {@link settleAfterSend}, from its first line to its return. */
export const SETTLE_DEADLINE_MS = 1200;

/**
 * After a key was sent, wait until the pane's text differs from what it showed when the key left, or
 * until a wall-clock deadline of {@link SETTLE_DEADLINE_MS} (1.2 s) passes.
 *
 * Why a tap needs this: the read a card revalidates on can land before the TUI repaints, and the
 * card would then keep the OLD highlight until the next idle poll (6 s). The next committing tap
 * compares the full signature of that stale picture with a fresh read and is refused. Awaiting this
 * before `revalidate()` makes the card show the picture the key produced, and the card stays
 * disabled for as long as its `onAction` promise is pending.
 *
 * The bound is time, not a count of sleeps: a read is a `fetchPane` with a 10 s timeout of its own,
 * so a stalled bridge would otherwise hold the cards for about 70 s. The loop checks the deadline
 * before each sleep and before each read, never sleeps past it, and gives each read an abort signal
 * that fires at the deadline. At most one read is in flight. The spacing between reads is
 * SETTLE_DELAYS_MS.
 *
 * The baseline is `args.from`, else the text the client had seen when its latest key was sent (the
 * read the entry guard made, or a choreography's last verified read; see `textBeforeLastSend`), so no
 * extra read is spent on it. With no baseline there is nothing to wait for and it returns at once.
 *
 * Never throws, and a timeout is a normal outcome: a key that changes nothing (Left at the end of a
 * scale) leaves the text as it was. A failed or aborted read counts as an unchanged one. Returns
 * whether a changed read was seen.
 *
 * A settle read refreshes the pane's ETag cache, so the `revalidate()` that follows can come back
 * "not modified" and count as a quiet poll. That is harmless: the burst a tap starts runs at least
 * BURST_MIN_POLLS (5, lib/poll-intent.ts) polls before quiet polls can end it.
 */
export async function settleAfterSend(args: {
  paneId: string;
  requestedLines: number;
  scope?: Scope;
  /** The text to wait to change. Defaults to the pane text at the latest key send. */
  from?: string;
  /** Test seams: the pacing, the clock and the read. `signal` aborts at the deadline. */
  sleep?: Sleep;
  now?: () => number;
  read?: (
    paneId: string,
    requestedLines: number,
    scope: Scope | undefined,
    signal: AbortSignal,
  ) => Promise<{ text: string }>;
}): Promise<boolean> {
  const from = args.from ?? textBeforeLastSend(args.paneId, args.scope);
  if (from === undefined) return false;
  const sleep = args.sleep ?? defaultSleep;
  const now = args.now ?? Date.now;
  const read = args.read ?? fetchPane;
  const deadline = now() + SETTLE_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTLE_DEADLINE_MS);
  // A seam that ignores its signal must not outlive the deadline either, so the read races the abort.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("settle deadline")), {
      once: true,
    });
  });
  aborted.catch(() => undefined);
  try {
    for (const delay of SETTLE_DELAYS_MS) {
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(delay, left));
      if (now() > deadline) break;
      try {
        const fresh = await Promise.race([
          read(args.paneId, args.requestedLines, args.scope, controller.signal),
          aborted,
        ]);
        if (fresh.text !== from) return true;
      } catch {
        // A failed read says nothing about the screen; the deadline is the timeout.
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitize free text before it is typed into a focused TUI input via the reply path. Collapse
 * whitespace to single spaces FIRST (so \t \n \r become word boundaries, not glue), then strip any
 * remaining C0/C1 control chars. Pasted clipboard text can smuggle in ESC (\x1b — blurs/cancels the
 * dialog), BEL (\x07 — "edit in nano"), ETX (\x03), etc., which the reply path would deliver
 * straight into the focused input BEFORE the readback check — so they must never reach it.
 */
export function sanitizeTypedText(text: string, maxLen: number): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, maxLen);
}

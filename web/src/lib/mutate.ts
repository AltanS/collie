// ── THE WRAPPER THAT MAKES A SWALLOWED FAILURE IMPOSSIBLE TO WRITE BY ACCIDENT ───────────────────
//
// A fire-and-forget mutation in this app has three honest outcomes and only three: it worked, it was
// refused (a `{ ok: false }` VALUE), or it threw (transport, timeout, a non-2xx with no recovered
// shape). The first two are already hard to get wrong — a refusal is a value the caller must read to
// do anything at all. The THIRD is the one that rots, because `try { … } finally { setBusy(false) }`
// looks finished: the spinner stops, the control comes back to life, and the operator is told
// nothing. That exact shape was measured in three places (components/snooze-control.tsx,
// hooks/use-notify-prefs.ts and the two action sheets' close rows) before this file existed.
//
// So: a mutation whose failure has nowhere else to go runs through {@link mutate}. On a throw it
// publishes the described error on the floating status channel (DESIGN.md §11 "Event"), which is the
// channel that answers "what happened, and why not?" — and it hands the caller back an outcome it
// cannot mistake for success.
//
// WHAT THIS IS NOT. It is NOT a house style every `lib/api.ts` call must adopt. Most call sites
// already report correctly, in their own words, with a `describeApiError(res, <their fallback>)`
// beside the throw branch; rewriting those through here would trade a specific sentence for a
// generic one and gain nothing. The rule is narrower and mechanical: **adopt it where a failure is
// currently swallowed.** lib/ack-manifest.ts records which channel every mutation actually uses, and
// is the thing that notices when a new one has none.
//
// WHY AN OUTCOME OBJECT AND NOT `T | undefined`. `undefined` is a legal success value for a 204
// endpoint (`doReq` returns it by contract), so "resolved undefined" cannot mean "failed" without
// lying about that case. A discriminated union is also what makes the revert-on-failure callers read
// correctly: `if (res.ok) … else …` is the whole control flow, with no `catch` for a later edit to
// quietly widen.

import { describeThrownError } from "./api-error-message";
import { setStatus } from "./status";

/** The result of one guarded mutation. `error` is the raw throw, for a caller that wants to branch
 *  on it (`isApiErrorStatus`) — the SENTENCE has already been published unless `ownError` was set. */
export type MutateOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface MutateOptions {
  /**
   * This call site has its OWN error surface, so `mutate` must not also publish one.
   *
   * The opt-out is explicit and named rather than inferred, because the surfaces that qualify are
   * real and correct: a DESIGN.md §11 **contextual notice** anchored in the control's own chrome
   * (the pairing card's line, the device row's revoke error, the update-check card's "couldn't
   * check"). Those outlive the operator's next interaction and belong beside the control that is
   * refusing — a floating event beside them would say the same thing twice, in the wrong category,
   * and fade out from under a condition that is still true.
   *
   * `true` only. There is no `ownError: false`, because that is the default and spelling it would
   * read as a decision when it is the absence of one.
   */
  ownError?: true;
}

/**
 * Run one mutating call. A throw becomes an error status and a `{ ok: false }` outcome.
 *
 * Deliberately takes a THUNK rather than a promise: `mutate(() => setSnooze(next))` cannot start the
 * request outside the guard, whereas `mutate(setSnooze(next))` would already have an unhandled
 * rejection in flight for the tick before this function got hold of it.
 *
 * It does NOT touch a `{ ok: false }` VALUE. A refusal the bridge authored carries a code and a
 * sentence that only the call site can put in context (`describeApiError(res, <fallback>)`), and
 * some of them are not errors at all — `prompt_changed` is a re-ask, not a failure.
 */
export async function mutate<T>(
  call: () => Promise<T>,
  options: MutateOptions = {},
): Promise<MutateOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!options.ownError) setStatus(describeThrownError(error), "error");
    return { ok: false, error };
  }
}

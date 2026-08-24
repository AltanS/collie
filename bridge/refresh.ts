// COALESCING "LOOK NOW" — one in-flight refresh per session, however many callers ask for it.
//
// `POST /api/refresh` is cheap but it is not free: on a censusing adapter it is a process, a round
// trip and a re-armed timer. And it arrives in bursts by construction — a phone coming back to the
// foreground fires one, the visibility listener fires another, and a pull-to-refresh on top of both
// is one gesture the operator experiences as a single act. Serving those as three listings would
// spend three processes answering one question.
//
// So a caller that asks while an answer is already on its way JOINS it rather than starting a
// second. That is a coalesce, not a debounce: nobody is made to wait for a window to close, and
// everybody gets the same promise resolving at the same moment — which is exactly the contract
// `refresh()` states (mux/types.ts), since one fresh listing satisfies every caller who asked for
// one before it ran.
//
// Keyed by SESSION rather than shared across the bridge: two sessions are two multiplexer targets,
// and one's listing says nothing about the other's. Within a session it is genuinely one in-flight.
//
// A failed refresh is not remembered. The key is cleared however the promise settled, so the next
// caller starts a fresh attempt rather than joining a rejection — a refresh that could not happen is
// one stale interval, and the retry is the operator's next tap.

/** One in-flight "look now" per key. Nothing here is a timer; nothing here holds state past settle. */
export class RefreshCoalescer {
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Run `look` for `key`, or join the run already under way for it.
   *
   * The returned promise is the SAME object every joining caller gets, so a route can await it and
   * answer honestly without knowing whether it was the one that caused the work.
   */
  run(key: string, look: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    // `finally` rather than `then`, so a rejected refresh clears the slot too — otherwise one failed
    // listing would pin every later caller onto the same rejection for the life of the process.
    const started = look().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /** How many refreshes are in flight. For tests and for nothing else. */
  get pending(): number {
    return this.inFlight.size;
  }
}

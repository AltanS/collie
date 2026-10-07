// The glide's scheduler: ONE pending slot, so a navigation that wants a view transition never calls
// `startViewTransition` while the previous transition's update callback is still pending.
//
// Port of kody's `view-transition-scheduler.ts` (research note 07, c.3), reshaped for a job that is a
// NAVIGATION and not a DOM swap. Chrome throws `InvalidStateError` (or silently skips the old
// transition mid-callback) when a transition starts under a pending one; the old rule in `glide.ts`
// covered the case where a glide is still `active`, and missed the gap where a move skipped it (a
// location change that was not the glide's own) and its callback was still awaiting the landing.
//
//   - `schedule(job)` starts at once when no callback is pending, else QUEUES the job and starts it
//     when `updateCallbackDone` settles. One slot: a newer job takes it, LATEST WINS.
//   - A job that loses the slot, or meets an instant path, is NOT dropped: its navigation is the
//     user's tap and the history entry it makes is part of the app's state (ADR 0067). It goes
//     instantly, in arrival order, with no transition. "Cancel the queued transition" means exactly
//     that: the transition is cancelled, the move is kept.
//   - A queued job whose location moved on while it waited (`isStale`) is dropped: the user went
//     elsewhere, and replaying the tap would navigate backwards over them.
//   - A `begin` that throws (`startViewTransition` threw) falls back to an instant move.
//   - Every `updateCallbackDone` outcome, fulfilled or rejected, ends the wait and drains the slot.
//
// Pure: no document, no timers. `glide.ts` injects `begin` (start the transition, navigate, return
// `updateCallbackDone`) and `instant` (navigate with no transition).

export interface GlideSchedulerDeps<J> {
  /** Start the transition and the move; return its `updateCallbackDone`. May throw. */
  begin(job: J): Promise<void>;
  /** The move with no transition. */
  instant(job: J): void;
  /** A queued job the location outran. Defaults to never. */
  isStale?(job: J): boolean;
}

export interface GlideScheduler<J> {
  /** A glide is wanted for `job`: start it now, or queue it behind the pending callback. */
  schedule(job: J): void;
  /** `job` moves with no transition: any queued job goes first, instantly, then `job`. */
  instant(job: J): void;
  /** A callback is pending, or a job is queued. */
  busy(): boolean;
  /** Resolves once the newest started job's callback has settled and the slot has drained. Test helper. */
  whenSettled(): Promise<void>;
}

export function createGlideScheduler<J>(deps: GlideSchedulerDeps<J>): GlideScheduler<J> {
  let pending: Promise<void> | null = null;
  let queued: J | null = null;
  let idle: Promise<void> = Promise.resolve();

  function flush(): void {
    const job = queued;
    queued = null;
    if (job !== null) deps.instant(job);
  }

  function drain(): void {
    if (pending !== null || queued === null) return;
    const job = queued;
    queued = null;
    // The location moved on while the job waited: the tap is stale, drop it.
    if (deps.isStale?.(job) !== true) start(job);
  }

  function start(job: J): void {
    let done: Promise<void>;
    try {
      done = deps.begin(job);
    } catch {
      // `startViewTransition` threw: move instantly rather than leave the screen on the old page.
      deps.instant(job);
      return;
    }
    pending = done;
    const settle = (): void => {
      if (pending !== done) return;
      pending = null;
      drain();
    };
    idle = done.then(settle, settle);
  }

  return {
    schedule(job) {
      if (pending === null) {
        start(job);
        return;
      }
      flush();
      queued = job;
    },
    instant(job) {
      flush();
      deps.instant(job);
    },
    busy: () => pending !== null || queued !== null,
    whenSettled: () => idle,
  };
}

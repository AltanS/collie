// The state machine behind a scroll restore that has to wait for its content (research note 07, c.12;
// ACTION-PLAN D.6). `scrollMemory()` (lib/scroll.ts) writes a stored spot once, after the commit. When
// the rows arrive LATER (a poll lands after the first paint, a back move onto a dashboard the store
// has not refilled yet) the scroller is too short, the browser clamps the write, and two things go
// wrong: the reader lands at the top, and the clamped offset is recorded as the new spot, losing the
// real one. So:
//
//   - a target the page cannot reach yet is KEPT while the content is short, and the clamped offsets
//     the browser produces meanwhile are not remembered (`holds`);
//   - each time the content grows, the restore tries again (`step`), until the target is reachable,
//     the window closes, or the reader takes over (`cancel`).
//
// THE WINDOW IS 3 s. kody waits 15 s on a window scroll. Here the late content is a poll answer, and
// the reads that matter fire at once (page visible, `focus`, `online`, a store refilled by the beat
// that was already running), so 3 s covers a slow tailnet round trip with room. A longer wait is worse
// than none: the restore would fire after the reader has settled and yank a screen they are reading.
// Past the window the spot is left alone, still stored, for the next time the entry shows.
//
// Pure: no DOM, no timers; the caller reads the numbers (free inside a ResizeObserver callback) and
// passes the clock.

/** How long a restore keeps waiting for its content, in ms. */
export const RESTORE_WINDOW_MS = 3_000;

/** Pixels of play between "at the target" and "not yet" (sub-pixel scroll offsets). */
const SLACK = 1;

export interface RestoreView {
  /** `scrollTop` now. */
  at: number;
  /** The most the scroller can scroll now: `scrollHeight - clientHeight`. */
  max: number;
}

export type RestoreStep =
  /** Reachable: write this offset. The restore is finished. */
  | { kind: "write"; top: number }
  /** Not reachable yet: keep watching for growth. */
  | { kind: "wait" }
  /** Nothing left to do: reached, expired, cancelled or never armed. */
  | { kind: "done" };

export interface ScrollRestore {
  /** Start waiting for `top` at time `now`. A target at the top (<= 0) disarms. */
  arm(top: number, now: number): void;
  /** The reader took over (wheel, touch, key, pointer): stop. */
  cancel(): void;
  /** Whether a target is still being waited for. */
  readonly armed: boolean;
  /** The next move, given what the scroller can do now. Disarms unless it says `wait`. */
  step(view: RestoreView, now: number): RestoreStep;
  /** Whether a scroll event at `scrollTop` is the browser's clamp and must NOT be remembered. */
  holds(scrollTop: number): boolean;
}

export function createScrollRestore(windowMs: number = RESTORE_WINDOW_MS): ScrollRestore {
  let target = 0;
  let deadline = 0;
  let armed = false;
  return {
    arm(top, now) {
      armed = top > 0;
      target = armed ? top : 0;
      deadline = now + windowMs;
    },
    cancel() {
      armed = false;
    },
    get armed() {
      return armed;
    },
    step(view, now) {
      if (!armed) return { kind: "done" };
      if (view.max >= target) {
        armed = false;
        // Already there (the first write landed): nothing to write.
        return Math.abs(view.at - target) <= SLACK ? { kind: "done" } : { kind: "write", top: target };
      }
      if (now >= deadline) {
        armed = false;
        return { kind: "done" };
      }
      return { kind: "wait" };
    },
    holds(scrollTop) {
      return armed && scrollTop < target - SLACK;
    },
  };
}

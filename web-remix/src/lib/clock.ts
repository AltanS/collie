// One shared 1 s page clock for everything that counts down on screen: the cache chips' "Nm" and
// their warm/expiring/cold tint (web/src/components/cache-chip.tsx reads one shared clock too). One
// interval for the whole page, running only while something listens, so a dashboard of twenty chips
// costs one timer, and a screen with no chip costs none.
//
// Readers subscribe through `useStore(handle, clock)`, which wakes them through `scheduleUpdate`
// (rule 1). A ticking label that must not re-render its parent writes `textContent` instead
// (REMIX3.md, "When to bypass render").
import { createStore, type Store } from "./store";

export const CLOCK_MS = 1000;

export interface Clock extends Store<number> {
  /** Listeners right now; the interval runs only while this is above zero. */
  listeners(): number;
}

export function createClock(
  now: () => number = Date.now,
  every: (fn: () => void, ms: number) => () => void = (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
): Clock {
  const inner = createStore(now());
  let count = 0;
  let stop: (() => void) | undefined;
  return {
    get: inner.get,
    set: inner.set,
    update: inner.update,
    version: inner.version,
    listeners: () => count,
    subscribe(listener, signal) {
      if (signal?.aborted) return () => {};
      let live = true;
      const off = inner.subscribe(listener);
      count++;
      if (count === 1) {
        inner.set(now()); // a clock that slept starts from the present, not from when it stopped
        stop = every(() => inner.set(now()), CLOCK_MS);
      }
      const end = (): void => {
        if (!live) return;
        live = false;
        off();
        count--;
        if (count === 0) {
          stop?.();
          stop = undefined;
        }
      };
      signal?.addEventListener("abort", end, { once: true });
      return end;
    },
  };
}

/** The page's clock, in epoch milliseconds, advanced once a second while read. */
export const clock = createClock();

// One shared 1 s page clock for everything that counts down on screen: the cache chips' "Nm" and
// their warm/expiring/cold tint (web/src/components/cache-chip.tsx reads one shared clock too). One
// interval for the whole page, running only while something listens AND the page is visible, so a
// dashboard of twenty chips costs one timer, a screen with no chip costs none, and a hidden tab
// costs none.
//
// Why a second and not a minute: the chip's label is `floor((expiresAt - now) / 60 s)` and its tint
// turns cold 10 s past `expiresAt` (web's `cacheChipView`). Those borders sit at each pane's OWN
// offset inside the wall-clock minute, so a clock that published on wall-clock minutes would show
// every chip up to 59 s late. The clock therefore publishes each second, and a reader that needs
// less wakes itself less: `useStoreSelect` (lib/store.ts) re-renders a chip only on the second its
// text or tint changes, which is once a minute per chip, not once a second.
//
// Hidden: no frames and no reader to draw for, so the interval stops. Coming back visible starts it
// from the present (the same path as the first listener returning), which notifies once, so a chip
// that crossed a border while hidden draws the right text on the first visible frame.
//
// Readers subscribe through `useStoreSelect(handle, clock, select)` (or `useStore` for one that
// really wants every tick), which wakes them through `scheduleUpdate` (rule 1). A ticking label that
// must not re-render its parent writes `textContent` instead (REMIX3.md, "When to bypass render").
import { createStore, type Store } from "./store";

export const CLOCK_MS = 1000;

export interface Clock extends Store<number> {
  /** Listeners right now; the interval runs only while this is above zero and the page is visible. */
  listeners(): number;
}

/** Whether the page can be seen, and when that changes. A test passes a fake. */
export interface PageVisibility {
  visible(): boolean;
  /** Calls `fn` on every change; returns the unsubscribe. */
  onChange(fn: () => void): () => void;
}

const documentVisibility: PageVisibility = {
  // No `document` under a plain bun test: such a page is always visible.
  visible: () => !("document" in globalThis) || document.visibilityState !== "hidden",
  onChange(fn) {
    if (!("document" in globalThis)) return () => {};
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

export function createClock(
  now: () => number = Date.now,
  every: (fn: () => void, ms: number) => () => void = (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  page: PageVisibility = documentVisibility,
): Clock {
  const inner = createStore(now());
  let count = 0;
  let stop: (() => void) | undefined;
  let unwatch: (() => void) | undefined;

  /** The interval runs exactly while someone listens and the page is visible. */
  const sync = (): void => {
    const want = count > 0 && page.visible();
    if (want && stop === undefined) {
      inner.set(now()); // a clock that slept starts from the present, not from when it stopped
      stop = every(() => inner.set(now()), CLOCK_MS);
    } else if (!want && stop !== undefined) {
      stop();
      stop = undefined;
    }
  };

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
      if (count === 1) unwatch = page.onChange(sync);
      sync();
      const end = (): void => {
        if (!live) return;
        live = false;
        off();
        count--;
        if (count === 0) {
          unwatch?.();
          unwatch = undefined;
          sync();
        }
      };
      signal?.addEventListener("abort", end, { once: true });
      return end;
    },
  };
}

/** The page's clock, in epoch milliseconds, advanced once a second while read and visible. */
export const clock = createClock();

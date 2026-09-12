// ONE interval for every cache chip on the page, and it stops when nobody is looking.
//
// A chip that owned its own timer would mean forty timers on a busy dashboard, each waking the tab
// independently. So there is one module-level interval, started by the first subscriber and cleared by
// the last, and chips read it through `useSyncExternalStore` — the pattern `use-locale.ts` already
// uses for the locale store.
//
// IT STOPS WHILE THE DOCUMENT IS HIDDEN, and that is not only a battery decision: a backgrounded tab
// has its timers throttled anyway, so a chip that relied on ticks to stay true would already be wrong
// on return. Reading `Date.now()` on the visibility change instead makes the chip correct the moment
// it is looked at, which is the only moment it matters.
//
// NO CHIP EVER FETCHES. The tick only moves the clock a pure view function is measured against; the
// `expiresAt` it is measured against arrives with the ordinary snapshot poll.

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;
/** The clock every chip reads. Bumped by the tick, and re-read on becoming visible. */
let nowMs = Date.now();

/** The current clock, as a snapshot `useSyncExternalStore` can compare by identity. */
export function cacheClockNow(): number {
  return nowMs;
}

/**
 * Subscribe to the page clock. Returns the unsubscribe.
 *
 * The first subscriber starts the interval, the last one stops it — so a page with no chip on it (every
 * screen except the dashboard and a pane) pays nothing at all.
 */
export function subscribeCacheClock(fn: () => void): () => void {
  listeners.add(fn);
  bindVisibility();
  start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}

function tick(): void {
  nowMs = Date.now();
  for (const fn of listeners) fn();
}

/** Is anybody looking? `document` always exists here — this bundle has no server render. */
function visible(): boolean {
  return document.visibilityState === "visible";
}

function start(): void {
  if (timer !== null || listeners.size === 0 || !visible()) return;
  timer = setInterval(tick, TICK_MS);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Listen once, for the life of the document.
 *
 * Never removed, because there is nothing to remove it on: the module lives as long as the page does,
 * and the handler's whole body is guarded by `listeners.size`. Binding it per subscriber would add and
 * drop a listener forty times on one dashboard render.
 */
function bindVisibility(): void {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (visible()) {
      // Correct the clock BEFORE resuming, so the first repaint after a return is already true rather
      // than a second stale.
      tick();
      start();
      return;
    }
    stop();
  });
}

/** Reset the module for a test. Not called by app code — there is one document and one clock in it. */
export function resetCacheClockForTests(): void {
  stop();
  listeners.clear();
  nowMs = Date.now();
}

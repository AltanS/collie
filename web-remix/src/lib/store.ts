// Module-level stores, and the ONE way a component re-renders from them.
//
// A store is a value with `get()`, `set()` and `subscribe()`. Nothing about it knows Remix: the
// polling scheduler writes stores, components read them.
//
// THE RULE (spike probe 3): no store notification calls `handle.update()` directly. Remix's runtime
// refuses more than 50 cascading updates in one turn ("handle.update() infinite loop detected") and
// DROPS the excess, so a burst of notifications (a poll that writes three stores, a socket that
// writes sixty frames) leaves the screen stale. Every notification goes through `scheduleUpdate`,
// which coalesces a component's updates into one per animation frame (one per timer while a view
// transition holds frames, `holdFrames`).

/** The part of a Remix `Handle` the coalescer needs. Every `Handle<Props>` satisfies it. */
export interface Updatable {
  update(): Promise<AbortSignal>;
  queueTask(task: (signal: AbortSignal) => void): void;
  readonly signal: AbortSignal;
}

export interface Store<T> {
  get(): T;
  set(next: T): void;
  /** Rewrites the value from the current one. */
  update(change: (current: T) => T): void;
  /**
   * Calls `listener` after every change; returns the unsubscribe. With a `signal` the listener also
   * ends when it aborts, so a component writes `store.subscribe(fn, handle.signal)` and cannot forget
   * the cleanup (REMIX3.md, "A module store is right when").
   */
  subscribe(listener: () => void, signal?: AbortSignal): () => void;
  /** Bumped on every change, so a late subscriber can tell it missed one. */
  version(): number;
}

/**
 * Every store made where there is no document: on the bridge, which renders documents (S1), and in
 * the unit tests. The browser never fills it. A server render primes stores for one request and
 * {@link resetStores} puts every one back to its first value right after, so the next request starts
 * from the same blank state (`ssr/render.tsx`).
 */
const serverStores: Array<() => void> = [];

/** Put every store made without a document back to its first value, with no notification. */
export function resetStores(): void {
  for (const reset of serverStores) reset();
}

export function createStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  let version = 0;
  const listeners = new Set<() => void>();
  if (!("document" in globalThis)) {
    serverStores.push(() => {
      value = initial;
      version = 0;
    });
  }
  const set = (next: T): void => {
    if (equal(value, next)) return;
    value = next;
    version++;
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    set,
    update: (change) => set(change(value)),
    subscribe(listener, signal) {
      const stop = (): void => {
        listeners.delete(listener);
      };
      if (signal?.aborted) return stop;
      listeners.add(listener);
      signal?.addEventListener("abort", stop, { once: true });
      return stop;
    },
    version: () => version,
  };
}

// ── The animation-frame coalescer: one wait per handle, one shared frame per turn ───────────────

/** What one wake-up of the shared frame is waiting on. */
interface Flush {
  /** "frame" for a requestAnimationFrame id, "timer" for a setTimeout id. */
  kind: "frame" | "timer";
  id: number;
}

/** Handles waiting for the next flush, each with its one update. Per-handle coalescing lives here. */
const waiting = new Map<Updatable, () => void>();
/** The one frame or timer that will run everything in `waiting`; null when nothing is waiting. */
let flushing: Flush | null = null;
/** Holders of `holdFrames`; above zero, updates run on timers instead of animation frames. */
let holds = 0;

/**
 * Frame scheduler: an animation frame normally; a timer when no frame will come. A hidden page gets
 * no animation frames, and a hidden page polls nothing anyway, so that timer is rare and slow.
 */
function arm(): Flush {
  if (holds > 0) return { kind: "timer", id: window.setTimeout(flush, 0) };
  if (document.visibilityState === "visible") return { kind: "frame", id: requestAnimationFrame(flush) };
  return { kind: "timer", id: window.setTimeout(flush, 50) };
}

/**
 * Run every waiting update in one turn, from ONE frame or timer however many handles wait. Before
 * this, each handle armed its own rAF and the runtime armed its own guard-reset timer after each
 * flush: five components on the 1 s clock were five frames and one timer per second (measured,
 * `experiments/remix-v3/bench/results/resources-2026-10-07-316e7159-attrib.md`).
 *
 * The 50-update guard is per component (`C/src/runtime/scheduler.ts`, MAX_CASCADING_COMPONENT_UPDATES)
 * and a handle waits at most once, so a shared frame gives each component one cascading update. The
 * scheduler's turn-wide count only warns, at 50 components; the screens wake a few tens at most (a
 * poll, a minute border on a dashboard of chips), and they all shared one frame before as well, since
 * every rAF callback of a frame runs in the same turn. A handle that asks again while this runs waits
 * for the next flush.
 */
function flush(): void {
  flushing = null;
  const due = [...waiting.values()];
  waiting.clear();
  for (const run of due) run();
}

/**
 * Run every scheduled update on a timer until the returned release is called (REMIX3.md, "Frames
 * during a view transition"). Chromium runs no animation frames while a view transition's update
 * callback is pending, so an update waiting for a frame waits for the whole callback: the glide's
 * arriving header never drew and the glide fell back to a crossfade after a 430 ms freeze. A timer
 * ends the turn, so the scheduler's 50-update guard is as safe as with frames, and the per-handle
 * coalescing is unchanged. Turning it on re-arms the updates already waiting for a frame. The store
 * knows nothing of the glide: `lib/glide.ts` holds it from `startViewTransition` to the end of the
 * update callback. The release is idempotent.
 */
export function holdFrames(): () => void {
  holds++;
  if (holds === 1 && flushing?.kind === "frame") {
    cancelAnimationFrame(flushing.id);
    flushing = arm();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}

/** True while some caller holds frames; for tests. */
export function framesHeld(): boolean {
  return holds > 0;
}

/**
 * Ask for ONE re-render of `handle` in the next frame. Any number of calls before that frame
 * collapse into the one update, and every handle asking in the same turn shares the one frame. A
 * disconnected component is never updated.
 */
export function scheduleUpdate(handle: Updatable): void {
  if (handle.signal.aborted || waiting.has(handle)) return;
  waiting.set(handle, () => {
    if (handle.signal.aborted) return;
    void handle.update();
  });
  flushing ??= arm();
}

/**
 * Subscribe a component to `store` for its lifetime and return a reader.
 *
 * Call it in the component's SETUP function (it runs once). The subscription starts in
 * `handle.queueTask`, after the first commit, because `handle.update()` may not be called before
 * then; a change that landed between setup and that first task is caught by the version check.
 * It ends when `handle.signal` aborts, which is when the component leaves the tree.
 */
export function useStore<T>(handle: Updatable, store: Store<T>): () => T {
  const seen = store.version();
  let started = false;
  handle.queueTask(() => {
    if (started || handle.signal.aborted) return;
    started = true;
    store.subscribe(() => scheduleUpdate(handle), handle.signal);
    if (store.version() !== seen) scheduleUpdate(handle);
  });
  return store.get;
}

/**
 * Like `useStore`, but a change wakes the component only when `select(value)` differs from what its
 * last render read. For a store that publishes often and a reader whose output changes rarely: the
 * 1 s clock under a cache chip, whose label moves once a minute. The reader returns the value and
 * records its selection, so call it in render. `select` may read `handle.props`; it runs on every
 * change, so keep it cheap and pure.
 */
export function useStoreSelect<T, S extends string | number | boolean | null>(
  handle: Updatable,
  store: Store<T>,
  select: (value: T) => S,
): () => T {
  let seen: S | symbol = NOTHING;
  handle.queueTask(() => {
    if (handle.signal.aborted) return;
    const wake = (): void => {
      if (!Object.is(select(store.get()), seen)) scheduleUpdate(handle);
    };
    store.subscribe(wake, handle.signal);
    wake(); // a change between the first render and this task
  });
  return () => {
    const value = store.get();
    seen = select(value);
    return value;
  };
}

const NOTHING: unique symbol = Symbol("nothing read yet");

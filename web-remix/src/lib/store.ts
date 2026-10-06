// Module-level stores, and the ONE way a component re-renders from them.
//
// A store is a value with `get()`, `set()` and `subscribe()`. Nothing about it knows Remix: the
// polling scheduler writes stores, components read them.
//
// THE RULE (spike probe 3): no store notification calls `handle.update()` directly. Remix's runtime
// refuses more than 50 cascading updates in one turn ("handle.update() infinite loop detected") and
// DROPS the excess, so a burst of notifications (a poll that writes three stores, a socket that
// writes sixty frames) leaves the screen stale. Every notification goes through `scheduleUpdate`,
// which coalesces a component's updates into one per animation frame.

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

export function createStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  let version = 0;
  const listeners = new Set<() => void>();
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

// ── The per-component animation-frame coalescer ──────────────────────────────────────────────────

const pending = new WeakMap<Updatable, number>();

/** Frame scheduler, swappable so a hidden tab (no animation frames) still settles. */
function nextFrame(run: () => void): number {
  if (document.visibilityState === "visible") return requestAnimationFrame(run);
  // A hidden page gets no animation frames; a timer keeps the store and the DOM in step, and a
  // hidden page polls nothing anyway, so this path is rare and cheap.
  return window.setTimeout(run, 50);
}

/**
 * Ask for ONE re-render of `handle` in the next frame. Any number of calls before that frame
 * collapse into the one update. A disconnected component is never updated.
 */
export function scheduleUpdate(handle: Updatable): void {
  if (handle.signal.aborted || pending.has(handle)) return;
  const id = nextFrame(() => {
    pending.delete(handle);
    if (handle.signal.aborted) return;
    void handle.update();
  });
  pending.set(handle, id);
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

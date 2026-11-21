import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onPreloadError, preloadQuietly, PRELOAD_RELOAD_KEY, setChunkReloader } from "./chunk-reload";
import { __resetChunkPreloads, drainChunkPreloads, lazyChunk, lazyScreen, preloadOf } from "./lazy-route";
import { __resetReloadGuard } from "./reload-guard";

function Screen() {
  return null;
}

describe("a lazy screen", () => {
  let reloads: number;

  beforeEach(() => {
    reloads = 0;
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
    __resetReloadGuard();
    setChunkReloader(() => {
      reloads += 1;
    });
  });

  afterEach(() => {
    setChunkReloader(null);
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
  });

  it("hands React Router the component its module names", async () => {
    const lazy = lazyScreen(() => Promise.resolve({ Screen }), (m) => m.Screen);
    await expect(lazy()).resolves.toEqual({ Component: Screen });
    expect(reloads).toBe(0);
  });

  it("reloads once when a navigation cannot fetch its chunk, and still fails the navigation", async () => {
    const missing = new TypeError("Failed to fetch dynamically imported module");
    const lazy = lazyScreen(() => Promise.reject(missing), () => Screen);
    await expect(lazy()).rejects.toBe(missing);
    expect(reloads).toBe(1);
  });

  it("keeps the old screen when Vite's own listener already started the reload", async () => {
    // Vite resolves the import with undefined once its `vite:preloadError` listener cancelled the rethrow.
    const lazy = lazyScreen<{ Screen: typeof Screen } | undefined>(() => Promise.resolve(undefined), (m) => m.Screen);
    const settled = vi.fn();
    void lazy().then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
  });

  it("gives the preload the bare import, which never reloads", async () => {
    const load = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const lazy = lazyScreen(load, () => Screen);
    const bare = preloadOf(lazy);
    expect(bare).not.toBeNull();
    await preloadQuietly(bare ?? (() => Promise.resolve()));
    expect(load).toHaveBeenCalledTimes(1);
    expect(reloads).toBe(0);
  });

  it("ignores Vite's preload error while a background preload is in flight", async () => {
    let fail: (error: Error) => void = () => undefined;
    const load = () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    const run = preloadQuietly(load);
    // What Vite does inside a failed import: the event first, then the rethrow.
    const event = new Event("vite:preloadError", { cancelable: true });
    onPreloadError(event);
    expect(event.defaultPrevented).toBe(false);
    fail(new TypeError("Failed to fetch dynamically imported module"));
    await run;
    expect(reloads).toBe(0);
    // After the preload the listener reloads as before.
    const later = new Event("vite:preloadError", { cancelable: true });
    onPreloadError(later);
    expect(later.defaultPrevented).toBe(true);
    expect(reloads).toBe(1);
  });

  it("knows no preload for a lazy it did not make", () => {
    expect(preloadOf(() => Promise.resolve({}))).toBeNull();
    expect(preloadOf(undefined)).toBeNull();
  });

  it("imports a chunk that is not a route through the same reload, and hands it to the preload", async () => {
    __resetChunkPreloads();
    const missing = new TypeError("Failed to fetch dynamically imported module");
    const load = vi.fn(() => Promise.reject(missing));
    const open = lazyChunk(load);
    await expect(open()).rejects.toBe(missing);
    expect(reloads).toBe(1);
    const queued = drainChunkPreloads(() => undefined);
    expect(queued).toHaveLength(1);
    await preloadQuietly(queued[0] ?? (() => Promise.resolve()));
    expect(load).toHaveBeenCalledTimes(2);
    expect(reloads).toBe(1);
    __resetChunkPreloads();
  });
});

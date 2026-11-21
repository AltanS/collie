import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decidePreloadReload,
  onPreloadError,
  PRELOAD_RELOAD_KEY,
  PRELOAD_RELOAD_WINDOW_MS,
  reloadForMissingChunk,
  reloadOnChunkError,
  setChunkReloader,
  type PreloadErrorEvent,
} from "./chunk-reload";
import { __resetReloadGuard, holdReload } from "./reload-guard";

/** The event Vite dispatches for a failed import, carrying `payload`. */
function preloadError(payload: Error = new TypeError("Failed to fetch dynamically imported module: /assets/x.js")): PreloadErrorEvent {
  return Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload });
}

function stubSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe("decidePreloadReload", () => {
  it("reloads when nothing reloaded before", () => {
    expect(decidePreloadReload({ now: 1000, last: null, held: false })).toBe("reload");
  });
  it("does not reload twice inside the window", () => {
    expect(decidePreloadReload({ now: 1000 + PRELOAD_RELOAD_WINDOW_MS - 1, last: 1000, held: false })).toBe("recent");
  });
  it("reloads again once the window has passed", () => {
    expect(decidePreloadReload({ now: 1000 + PRELOAD_RELOAD_WINDOW_MS, last: 1000, held: false })).toBe("reload");
  });
  it("never reloads over a held draft", () => {
    expect(decidePreloadReload({ now: 1000, last: null, held: true })).toBe("held");
  });
});

describe("the reload on a missing chunk", () => {
  let store: Map<string, string>;
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    store = stubSessionStorage();
    reload.mockReset();
    setChunkReloader(reload);
    __resetReloadGuard();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setChunkReloader(null);
    __resetReloadGuard();
  });

  it("reloads once, stamps the time, and cancels Vite's rethrow", () => {
    const event = preloadError();
    onPreloadError(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(store.get(PRELOAD_RELOAD_KEY)).toBe(String(Date.now()));
  });

  it("does not reload a second time inside 60 s, and leaves the event alone", () => {
    onPreloadError(preloadError());
    vi.advanceTimersByTime(PRELOAD_RELOAD_WINDOW_MS - 1);
    const event = preloadError();
    onPreloadError(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads again after 60 s", () => {
    onPreloadError(preloadError());
    vi.advanceTimersByTime(PRELOAD_RELOAD_WINDOW_MS);
    onPreloadError(preloadError());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload over a held draft, and does not stamp", () => {
    holdReload("composer");
    const event = preloadError();
    onPreloadError(event);
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(store.has(PRELOAD_RELOAD_KEY)).toBe(false);
  });

  it("does not reload when the stamp cannot be stored", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(reloadForMissingChunk()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once for a plain import() that fails, then rethrows", async () => {
    const failure = new Error("Failed to fetch dynamically imported module");
    await expect(reloadOnChunkError(() => Promise.reject(failure))).rejects.toBe(failure);
    await expect(reloadOnChunkError(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("passes a successful import() through untouched", async () => {
    await expect(reloadOnChunkError(() => Promise.resolve(7))).resolves.toBe(7);
    expect(reload).not.toHaveBeenCalled();
  });
});

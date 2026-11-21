import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isChunkFetchError,
  onPreloadError,
  PRELOAD_RELOAD_KEY,
  reloadOnChunkError,
  setChunkReloader,
  type PreloadErrorEvent,
} from "./chunk-reload";
import { lazyScreen } from "./lazy-route";
import { __resetReloadGuard } from "./reload-guard";

function Screen() {
  return null;
}

function preloadError(payload: Error): PreloadErrorEvent {
  return Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload });
}

// What each engine, and Vite's CSS preload, says when a chunk cannot be fetched.
const FETCH_FAILURES = [
  new TypeError("Failed to fetch dynamically imported module: https://collie.example/assets/settings-AbC123.js"),
  new TypeError("Importing a module script failed."),
  new TypeError("error loading dynamically imported module: https://collie.example/assets/settings-AbC123.js"),
  new Error("Unable to preload CSS for /assets/settings-AbC123.css"),
];

describe("a reload only for a chunk that could not be fetched", () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
    reload.mockClear();
    setChunkReloader(reload);
  });
  afterEach(() => {
    setChunkReloader(null);
    __resetReloadGuard();
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
  });

  it("knows each engine's words for a failed fetch, and nothing else", () => {
    for (const failure of FETCH_FAILURES) expect(isChunkFetchError(failure)).toBe(true);
    expect(isChunkFetchError(new TypeError("settingsRows is not iterable"))).toBe(false);
    expect(isChunkFetchError(new ReferenceError("t is not defined"))).toBe(false);
    expect(isChunkFetchError(undefined)).toBe(false);
  });

  it("reloads for a failed fetch through either door", async () => {
    const failure = FETCH_FAILURES[0] ?? new Error("unreachable");
    await expect(reloadOnChunkError(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(reload).toHaveBeenCalledTimes(1);
    sessionStorage.removeItem(PRELOAD_RELOAD_KEY);
    const event = preloadError(failure);
    onPreloadError(event);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it("never reloads for an error a screen module throws in its own top-level code", async () => {
    // A real import of a module that throws while it is evaluated: the error is the module's own.
    let thrown: Error = new Error("the fixture did not throw");
    await import("./chunk-reload-throws.fixture").catch((error: Error) => {
      thrown = error;
    });
    expect(thrown.message).toBe("settingsRows is not iterable");

    await expect(reloadOnChunkError(() => import("./chunk-reload-throws.fixture"))).rejects.toThrow("settingsRows is not iterable");
    // Vite's helper fires its event for the same throw (`baseModule().catch(handlePreloadError)`).
    const event = preloadError(thrown);
    onPreloadError(event);
    expect(event.defaultPrevented).toBe(false);
    // A lazy screen that throws goes to the route's error screen with the module's error.
    const lazy = lazyScreen(() => import("./chunk-reload-throws.fixture"), () => Screen);
    await expect(lazy()).rejects.toThrow("settingsRows is not iterable");
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PRELOAD_RELOAD_KEY)).toBeNull();
  });
});

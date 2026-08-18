import { describe, expect, it, beforeEach, vi } from "vitest";
import { stubPart } from "@/test/stub";

import type { UseThemeReturn } from "./use-theme";

// use-theme keeps its state at module scope (so every reader of the preference agrees, and so the
// OS listener outlives the idle lock unmounting the router). Tests therefore re-import
// the module per case rather than resetting a hook instance.
//
// The shared matchMedia stub in test/setup.ts hands back a discard `addEventListener`, which can
// never fire — fine for everything else in the suite, useless for the one mechanism here that has no
// CSS fallback. So this file installs a controllable fake locally and leaves the shared one alone.

const STORAGE_KEY = "collie:theme:v1";

/** The controllable half of the local `matchMedia` fake: read the state, drive a change. */
interface MediaControl {
  matches: boolean;
  emit: (matches: boolean) => void;
}

let media: MediaControl;

function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
      void listeners.delete(fn),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  media = {
    get matches() {
      return mql.matches;
    },
    emit(matches: boolean) {
      mql.matches = matches;
      for (const fn of listeners) fn(stubPart<MediaQueryListEvent>({ matches }));
    },
  };
  vi.stubGlobal("matchMedia", () => mql);
}

/** Fresh module instance, so module-scope state doesn't leak between cases. */
async function loadModule(): Promise<{ useTheme: () => UseThemeReturn }> {
  vi.resetModules();
  return await import("./use-theme");
}

/** The hook's non-React surface is what matters here; drive it through the store it exports. */
async function bootstrap(stored: string | null, osDark = false) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  document.documentElement.className = "";
  installMatchMedia(osDark);
  return loadModule();
}

function classes(): string[] {
  return [...document.documentElement.classList];
}

describe("useTheme store", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  it("defaults to system when nothing is stored", async () => {
    const { useTheme } = await bootstrap(null);
    // Module-load side effect: no pin class, because System is not a pin.
    expect(classes()).toEqual([]);
    expect(useTheme).toBeTypeOf("function");
  });

  it("ignores a garbage stored value rather than pinning to it", async () => {
    await bootstrap("chartreuse");
    expect(classes()).toEqual([]);
  });

  it("stamps the pin class for a stored theme", async () => {
    await bootstrap("dark");
    expect(classes()).toEqual(["dark"]);
  });

  it("stores a BARE string, not JSON — theme-init.js does a strict compare", async () => {
    const { useTheme } = await bootstrap(null);
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("dark"));
    // The exact bytes theme-init.js compares against. JSON.stringify would write `"dark"` with the
    // quote characters, the strict compare would miss, and the anti-flash would silently die.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).not.toBe(JSON.stringify("dark"));
  });

  it("survives localStorage throwing (Safari private mode)", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await expect(bootstrap(null)).resolves.toBeDefined();
    expect(classes()).toEqual([]);
    spy.mockRestore();
  });

  it("resolves system against the OS", async () => {
    await bootstrap(null, true);
    // No class either way — the CSS `color-scheme: light dark` does the resolving. The point is that
    // module load does not spuriously pin.
    expect(classes()).toEqual([]);
  });

  it("gives both theme-color metas the pinned colour, so whichever matches is right", async () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">' +
      '<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">';
    await bootstrap("light");
    const contents = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
      (m) => m.content,
    );
    expect(contents).toEqual(["#f5f5f5", "#f5f5f5"]);
  });

  it("hands the metas back their own values on system", async () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#000" media="(prefers-color-scheme: light)">' +
      '<meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)">';
    await bootstrap(null);
    const contents = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
      (m) => m.content,
    );
    expect(contents).toEqual(["#f5f5f5", "#0a0a0a"]);
  });
});

describe("theme cycling and class teardown", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  // The single most likely bug in the feature: a stale class left on <html> means Dark → System
  // silently does nothing until a full reload.
  it("removes the pinned class when returning to system", async () => {
    const { useTheme } = await bootstrap("dark");
    expect(classes()).toEqual(["dark"]);

    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("system"));
    expect(classes()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("replaces rather than accumulates classes when switching pins", async () => {
    const { useTheme } = await bootstrap("dark");
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("light"));
    expect(classes()).toEqual(["light"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("tracks an OS flip while on system, and ignores it once pinned", async () => {
    const { useTheme } = await bootstrap(null, false);
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useTheme());

    expect(result.current.resolved).toBe("light");
    act(() => media.emit(true));
    expect(result.current.resolved).toBe("dark");

    act(() => result.current.setTheme("light"));
    act(() => media.emit(false));
    expect(result.current.resolved).toBe("light");
    act(() => media.emit(true));
    expect(result.current.resolved).toBe("light"); // pinned wins over the OS
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrandMark } from "@/components/brand-mark";
import { MARK_DRIFT } from "@/components/mark-contract";
import { __resetDesign, setDesignMarkMoves } from "@/lib/design";
import { STEPS_CLASS, currentMarkMoves, resolveMarkMoves } from "@/lib/mark-motion";
import { parseTheme, type Theme } from "@/lib/theme/schema";
import { LIBRARY_STORAGE_KEY, __resetThemeStore, setActiveTheme } from "@/lib/theme/store";
import { collieMark } from "@/test/collie-mark";

// Whether the header character moves at rest (lib/mark-motion.ts). The marks are the real generated
// ones, so a case reads the contract's own `data-still`: present while the orbit is held, absent while
// it runs. jsdom runs no animation, so the attribute is what the mark says it does.

const still = (container: ParentNode): boolean => collieMark(container)?.hasAttribute("data-still") === true;

const THEME_STILL = { version: 5, id: "calm", name: "Calm", characterMotion: "still", light: { background: "#fdfaf3" } };
const THEME_MOVES = { version: 5, id: "lively", name: "Lively", characterMotion: "moves", light: { background: "#fdfaf3" } };

/** Import themes and wear one, as the picker's own tests do. */
function wear(id: string, ...themes: object[]): void {
  localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, themes }));
  __resetThemeStore();
  act(() => setActiveTheme(id));
}

/** Say the page is hidden or visible, the way the browser does. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Answer `prefers-reduced-motion` with `matches` for the rest of the case. */
function reduceMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") && matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
  __resetThemeStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Puts back jsdom's own reading: the stub is an own property of `document`, the real one is on its prototype.
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

describe("a resting mark", () => {
  it("drifts at once with no input on a visible page, and keeps on drifting past the old window", () => {
    vi.useFakeTimers();
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(collieMark(container)?.getAttribute("data-state")).toBe("rest");
    expect(still(container)).toBe(false);
    act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs + MARK_DRIFT.easeMs + 1000));
    expect(still(container)).toBe(false);
  });

  it("wears the steps class while it drifts, so the engine draws about 12 frames a second, and not while it is held", () => {
    const { container } = render(<BrandMark size={44} weight="header" className="x" />);
    expect(collieMark(container)?.classList.contains(STEPS_CLASS)).toBe(true);
    expect(collieMark(container)?.classList.contains("x")).toBe(true);
    act(() => setDesignMarkMoves(false));
    expect(collieMark(container)?.classList.contains(STEPS_CLASS)).toBe(false);
  });

  it("does not step a live state, which turns smooth for a short time", () => {
    const { container } = render(<BrandMark size={44} weight="header" state="loading" />);
    expect(collieMark(container)?.classList.contains(STEPS_CLASS)).toBe(false);
  });

  it("has a stylesheet rule for the steps class: a stepped timing at about 12 a second, and the pearls' twinkle", () => {
    const css = readFileSync(join(__dirname, "../index.css"), "utf8");
    expect(css).toMatch(/\.mark-steps \*\s*\{\s*animation-timing-function: steps\(10, end\), step-end !important;/u);
    expect(css).toContain("steps(20, end), step-end !important");
    expect(css).toContain(".ck-tw");
  });

  it("rests while the page is hidden, and drifts on again when it is visible", () => {
    const { container } = render(<BrandMark size={44} weight="header" />);
    setVisibility("hidden");
    expect(still(container)).toBe(true);
    setVisibility("visible");
    expect(still(container)).toBe(false);
  });

  it("rests on pagehide, and drifts on again on pageshow", () => {
    const { container } = render(<BrandMark size={44} weight="header" />);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(still(container)).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(still(container)).toBe(false);
  });

  it("rests under prefers-reduced-motion, whatever the switch says", () => {
    reduceMotion(true);
    setDesignMarkMoves(true);
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(true);
  });

  it("is held when the device's switch is off, at once, and drifts again when it is turned on", () => {
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(false);
    act(() => setDesignMarkMoves(false));
    expect(still(container)).toBe(true);
    act(() => setDesignMarkMoves(true));
    expect(still(container)).toBe(false);
  });

  it("is held when the worn theme says still", () => {
    wear("calm", THEME_STILL);
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(true);
  });

  it("drifts under a theme that says moves, and under one that says nothing", () => {
    wear("lively", THEME_MOVES);
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(false);
  });

  it("lets a switch that was touched beat the theme, both ways", () => {
    wear("calm", THEME_STILL);
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(true);
    act(() => setDesignMarkMoves(true));
    expect(still(container)).toBe(false);
    wear("lively", THEME_MOVES);
    act(() => setDesignMarkMoves(false));
    expect(still(container)).toBe(true);
  });

  it("follows the theme again on a device that never touched the switch", () => {
    wear("calm", THEME_STILL);
    const { container } = render(<BrandMark size={44} weight="header" />);
    expect(still(container)).toBe(true);
    act(() => setActiveTheme("collie"));
    expect(still(container)).toBe(false);
  });
});

describe("what the switch leaves alone", () => {
  it("a live state turns whatever the switch says", () => {
    act(() => setDesignMarkMoves(false));
    for (const state of ["loading", "applying", "reconnected"] as const) {
      const { container, unmount } = render(<BrandMark size={44} weight="header" state={state} />);
      expect(still(container), state).toBe(false);
      unmount();
    }
  });

  it("a mark whose caller sets turn or drift is drawn as asked", () => {
    act(() => setDesignMarkMoves(false));
    const held = render(<BrandMark size={44} weight="header" drift="in-use" />);
    // `in-use` and a page nobody touched: held by the contract's own rule, not by the switch.
    expect(still(held.container)).toBe(true);
    held.unmount();
    act(() => setDesignMarkMoves(true));
    const given = render(<BrandMark size={44} weight="header" turn={0} />);
    expect(still(given.container)).toBe(true);
  });

  it("the idle state holds where it is", () => {
    const { container } = render(<BrandMark size={44} weight="header" state="idle" />);
    expect(still(container)).toBe(true);
  });
});

describe("the one rule", () => {
  const worn = (characterMotion?: "moves" | "still"): Theme => {
    const colours = { light: { background: "#fdfaf3" } };
    const file = characterMotion === undefined ? { version: 1, id: "x", name: "X", ...colours } : { version: 5, id: "x", name: "X", characterMotion, ...colours };
    const parsed = parseTheme(JSON.stringify(file), { maxBytes: 65536 });
    if (!parsed.ok) throw new Error("refused");
    return parsed.theme;
  };

  it.each([
    [undefined, undefined, true],
    [undefined, "moves", true],
    [undefined, "still", false],
    [true, "still", true],
    [false, "moves", false],
    [false, undefined, false],
    [true, undefined, true],
  ] as const)("device %s, theme %s: moves %s", (device, motion, expected) => {
    expect(resolveMarkMoves({ device, trial: null, active: worn(motion) })).toBe(expected);
  });

  it("reads the theme being tried before the stored one", () => {
    expect(resolveMarkMoves({ device: undefined, trial: worn("still"), active: worn("moves") })).toBe(false);
    expect(resolveMarkMoves({ device: undefined, trial: worn("moves"), active: worn("still") })).toBe(true);
  });

  it("reads the live stores for code that is not a component", () => {
    expect(currentMarkMoves()).toBe(true);
    setDesignMarkMoves(false);
    expect(currentMarkMoves()).toBe(false);
  });
});

describe("hydration", () => {
  it("draws the same tree on the server and on the first client render, then drifts", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToString(<BrandMark size={44} weight="header" />);
    // The server draws a held mark: the snapshot is a page not yet read.
    expect(html).toContain("data-still");
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    act(() => {
      root = hydrateRoot(host, <BrandMark size={44} weight="header" />);
    });
    expect(errors).not.toHaveBeenCalled();
    // After hydration the client has read the page and the mark drifts.
    expect(collieMark(host)?.hasAttribute("data-still")).toBe(false);
    act(() => root?.unmount());
    host.remove();
    errors.mockRestore();
  });
});

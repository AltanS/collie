import { renderHook, act } from "@testing-library/react";
import { useDisplayPrefs } from "./use-display-prefs";

// Minimal localStorage stub — Vitest/jsdom includes a real one but this ensures it's clean per test.
const STORAGE_KEY = "collie:display-prefs:v4";

describe("useDisplayPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when localStorage is empty", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: true, fontSize: 12, rawTerminal: false, tapToFocus: true });
  });

  it("persists wrap=true and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setWrap(true));
    expect(result.current.prefs.wrap).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).wrap).toBe(true);
  });

  it("persists wrap=false and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setWrap(false));
    expect(result.current.prefs.wrap).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).wrap).toBe(false);
  });

  it("loads persisted prefs from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wrap: false, fontSize: 14, rawTerminal: true, tapToFocus: false }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 14, rawTerminal: true, tapToFocus: false });
  });

  it("persists rawTerminal and reloads it on mount (the escape hatch survives a reload)", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.rawTerminal).toBe(false);
    act(() => result.current.setRawTerminal(true));
    expect(result.current.prefs.rawTerminal).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).rawTerminal).toBe(true);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.rawTerminal).toBe(true);
  });

  it("persists tapToFocus and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.tapToFocus).toBe(true);
    act(() => result.current.setTapToFocus(false));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).tapToFocus).toBe(false);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.tapToFocus).toBe(false);
  });

  // The storage key was deliberately NOT bumped for tapToFocus: a payload written before it existed
  // must keep every other choice and take the default for the new one. A bump would have reset them.
  it("reads a pre-tapToFocus payload without discarding the prefs it does have", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wrap: false, fontSize: 15, rawTerminal: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 15, rawTerminal: true, tapToFocus: true });
  });

  it("setFontSize clamps below minimum to 9", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(3));
    expect(result.current.prefs.fontSize).toBe(9);
  });

  it("setFontSize clamps above maximum to 16", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(99));
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize increments within range", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(2)); // 12 + 2 = 14
    expect(result.current.prefs.fontSize).toBe(14);
  });

  it("stepFontSize does not exceed max", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(10)); // 12 + 10 = 22 → clamp to 16
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize does not go below min", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(-10)); // 12 - 10 = 2 → clamp to 9
    expect(result.current.prefs.fontSize).toBe(9);
  });

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: true, fontSize: 12, rawTerminal: false, tapToFocus: true });
  });

  it("falls back to defaults when stored value is not an object", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: true, fontSize: 12, rawTerminal: false, tapToFocus: true });
  });
});

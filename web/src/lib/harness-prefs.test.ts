import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __reloadHarnessPrefs,
  __resetHarnessPrefs,
  harnessStatusLineShown,
  setHarnessStatusLineShown,
  useHarnessStatusLineShown,
} from "./harness-prefs";

const KEY = "collie:harness-prefs:v1";

// The store remembers one bit per harness across a reload, so the contract is the default, the exact
// key and shape, and that hostile storage cannot take the Chat view down with it. An inverted default
// would quietly drop the strip from every pane of every operator.
describe("harness-prefs", () => {
  beforeEach(() => __resetHarnessPrefs());
  afterEach(() => __resetHarnessPrefs());

  it("shows the status line for every harness until the operator turns one off", () => {
    expect(harnessStatusLineShown("claude")).toBe(true);
    expect(harnessStatusLineShown("codex")).toBe(true);
    expect(harnessStatusLineShown("something-new")).toBe(true);
    expect(harnessStatusLineShown(undefined)).toBe(true);
  });

  it("sets one harness without touching another", () => {
    setHarnessStatusLineShown("claude", false);
    expect(harnessStatusLineShown("claude")).toBe(false);
    expect(harnessStatusLineShown("codex")).toBe(true);
    setHarnessStatusLineShown("claude", true);
    expect(harnessStatusLineShown("claude")).toBe(true);
  });

  it("persists one JSON object keyed by harness id, and a reload reads it back", () => {
    setHarnessStatusLineShown("claude", false);
    setHarnessStatusLineShown("pi", true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      claude: { statusLine: false },
      pi: { statusLine: true },
    });
    __reloadHarnessPrefs();
    expect(harnessStatusLineShown("claude")).toBe(false);
    expect(harnessStatusLineShown("pi")).toBe(true);
  });

  it.each([
    ["not JSON", "{oops"],
    ["null", "null"],
    ["an array", "[1,2]"],
    ["a string", '"claude"'],
    ["a wrong shape", '{"claude":"off","codex":null,"pi":{"statusLine":"no"}}'],
  ])("tolerates garbage in storage: %s reads as the default", (_name, raw) => {
    localStorage.setItem(KEY, raw);
    __reloadHarnessPrefs();
    expect(harnessStatusLineShown("claude")).toBe(true);
    expect(harnessStatusLineShown("codex")).toBe(true);
    expect(harnessStatusLineShown("pi")).toBe(true);
  });

  it("keeps the good entries beside a bad one", () => {
    localStorage.setItem(KEY, '{"claude":{"statusLine":false},"codex":7}');
    __reloadHarnessPrefs();
    expect(harnessStatusLineShown("claude")).toBe(false);
    expect(harnessStatusLineShown("codex")).toBe(true);
  });

  it("stores agy as antigravity, and reads either string from the one value", () => {
    setHarnessStatusLineShown("agy", false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ antigravity: { statusLine: false } });
    expect(harnessStatusLineShown("agy")).toBe(false);
    expect(harnessStatusLineShown("antigravity")).toBe(false);
    setHarnessStatusLineShown("antigravity", true);
    expect(harnessStatusLineShown("agy")).toBe(true);
  });

  it("does not read an inherited key as a stored one", () => {
    expect(harnessStatusLineShown("constructor")).toBe(true);
    expect(harnessStatusLineShown("__proto__")).toBe(true);
  });

  it("updates subscribers, which is what redraws the Chat view", () => {
    const { result } = renderHook(() => useHarnessStatusLineShown("claude"));
    expect(result.current).toBe(true);
    act(() => setHarnessStatusLineShown("claude", false));
    expect(result.current).toBe(false);
    act(() => setHarnessStatusLineShown("codex", false)); // another harness: no change here
    expect(result.current).toBe(false);
    act(() => __resetHarnessPrefs());
    expect(result.current).toBe(true);
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => setHarnessStatusLineShown("claude", false)).not.toThrow();
    expect(harnessStatusLineShown("claude")).toBe(false);
    setItem.mockRestore();
  });
});

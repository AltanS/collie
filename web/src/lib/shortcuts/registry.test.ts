import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetShortcutRegistry, hasShortcutTarget, paneKeySink, registerPaneKeySink, registerShortcutHandler, runShortcutAction } from "./registry";
import { chordToWireKey } from "./wire-key";

afterEach(() => __resetShortcutRegistry());

describe("the handler registry", () => {
  it("runs the handler of an action and says so", () => {
    const handler = vi.fn();
    registerShortcutHandler("zen_mode", handler);
    expect(runShortcutAction("zen_mode")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("an action with no handler is a no-op that says so", () => {
    expect(runShortcutAction("zen_mode")).toBe(false);
  });

  it("hands an indexed action its number", () => {
    const handler = vi.fn();
    registerShortcutHandler("switch_tab", handler);
    runShortcutAction("switch_tab", 4);
    expect(handler).toHaveBeenCalledWith(4);
  });

  it("the newest registration wins, and a stale one cannot remove it", () => {
    const first = vi.fn();
    const second = vi.fn();
    const forgetFirst = registerShortcutHandler("find", first);
    registerShortcutHandler("find", second);
    forgetFirst();
    runShortcutAction("find");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("forgets a handler when its registration ends", () => {
    const forget = registerShortcutHandler("find", vi.fn());
    forget();
    expect(runShortcutAction("find")).toBe(false);
  });

  it("a mode's key runs its own handler, not a global action's", () => {
    const space = vi.fn();
    const down = vi.fn();
    registerShortcutHandler("next_space", space);
    registerShortcutHandler("navigate_down", down);
    runShortcutAction("navigate_down");
    expect(down).toHaveBeenCalledTimes(1);
    expect(space).not.toHaveBeenCalled();
  });

  it("a mode has a target only while one of its keys has a handler", () => {
    expect(hasShortcutTarget("navigate")).toBe(false);
    expect(hasShortcutTarget("resize")).toBe(false);
    registerShortcutHandler("navigate_up", vi.fn());
    expect(hasShortcutTarget("navigate")).toBe(true);
    expect(hasShortcutTarget("resize")).toBe(false);
    registerShortcutHandler("resize_wider", vi.fn());
    expect(hasShortcutTarget("resize")).toBe(true);
  });
});

describe("the pane keyboard", () => {
  it("is the newest sink, and none after it leaves", () => {
    expect(paneKeySink()).toBeNull();
    const sink = { send: vi.fn(), isDirectTyping: () => false };
    const forget = registerPaneKeySink(sink);
    expect(paneKeySink()).toBe(sink);
    forget();
    expect(paneKeySink()).toBeNull();
  });
});

describe("a chord as a wire key", () => {
  const chord = { ctrl: false, shift: false, alt: false, meta: false };

  it("spells the default prefix as the Keys tray does", () => {
    expect(chordToWireKey({ ...chord, ctrl: true, key: "b" })).toBe("ctrl+b");
  });

  it("orders the modifiers and capitalises the named keys", () => {
    expect(chordToWireKey({ ...chord, shift: true, ctrl: true, alt: true, key: "tab" })).toBe("ctrl+alt+shift+Tab");
    expect(chordToWireKey({ ...chord, key: "esc" })).toBe("Escape");
    expect(chordToWireKey({ ...chord, ctrl: true, key: "f5" })).toBe("ctrl+F5");
    expect(chordToWireKey({ ...chord, ctrl: true, key: "space" })).toBe("ctrl+Space");
  });

  it("sends a symbol as itself", () => {
    expect(chordToWireKey({ ...chord, alt: true, key: "/" })).toBe("alt+/");
  });

  it("refuses a key it has no spelling for", () => {
    expect(() => chordToWireKey({ ...chord, key: "nonsense" })).toThrow(/no wire key/);
  });
});

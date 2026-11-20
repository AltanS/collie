import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIONS } from "./actions";
import { __resetShortcutRegistry, isShortcutActionAvailable, registerShortcutHandler, subscribeShortcutAvailability } from "./registry";

afterEach(() => __resetShortcutRegistry());

describe("isShortcutActionAvailable", () => {
  it("is false with no handler and true while one answers", () => {
    expect(isShortcutActionAvailable("find")).toBe(false);
    const forget = registerShortcutHandler("find", vi.fn());
    expect(isShortcutActionAvailable("find")).toBe(true);
    forget();
    expect(isShortcutActionAvailable("find")).toBe(false);
  });

  it("reads a mode's key by its own handler, not a global action's", () => {
    registerShortcutHandler("previous_space", vi.fn());
    expect(isShortcutActionAvailable("navigate_up")).toBe(false);
    registerShortcutHandler("navigate_up", vi.fn());
    expect(isShortcutActionAvailable("navigate_up")).toBe(true);
    expect(isShortcutActionAvailable("navigate_down")).toBe(false);
  });

  it("asks an action that opens a mode whether the mode has a target", () => {
    expect(isShortcutActionAvailable("navigate_mode")).toBe(false);
    expect(isShortcutActionAvailable("resize_mode")).toBe(false);
    registerShortcutHandler("navigate_down", vi.fn());
    expect(isShortcutActionAvailable("navigate_mode")).toBe(true);
    expect(isShortcutActionAvailable("resize_mode")).toBe(false);
    registerShortcutHandler("resize_wider", vi.fn());
    expect(isShortcutActionAvailable("resize_mode")).toBe(true);
  });

  it("knows every action of the table", () => {
    for (const action of ACTIONS) expect(isShortcutActionAvailable(action.id), action.id).toBe(false);
  });
});

describe("subscribeShortcutAvailability", () => {
  it("fires when a handler registers and when it goes", () => {
    const listener = vi.fn();
    subscribeShortcutAvailability(listener);
    const forget = registerShortcutHandler("find", vi.fn());
    expect(listener).toHaveBeenCalledTimes(1);
    forget();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not fire for a newer handler that replaces one, or for a stale one that leaves", () => {
    const forgetFirst = registerShortcutHandler("find", vi.fn());
    const listener = vi.fn();
    subscribeShortcutAvailability(listener);
    registerShortcutHandler("find", vi.fn());
    forgetFirst();
    expect(listener).not.toHaveBeenCalled();
    expect(isShortcutActionAvailable("find")).toBe(true);
  });

  it("stops when the subscription ends", () => {
    const listener = vi.fn();
    const stop = subscribeShortcutAvailability(listener);
    stop();
    registerShortcutHandler("find", vi.fn());
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires once when a reset clears handlers", () => {
    registerShortcutHandler("find", vi.fn());
    const listener = vi.fn();
    subscribeShortcutAvailability(listener);
    __resetShortcutRegistry();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

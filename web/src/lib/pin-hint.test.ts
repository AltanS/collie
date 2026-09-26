import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  __reloadPinHint,
  PIN_HINT_MIN_ROWS,
  pinHintRetired,
  retirePinHint,
  showsPinHint,
  usePinHintRetired,
} from "./pin-hint";
import { setPinned } from "./pins";
import type { AgentView } from "./types";

// The pin hint's flag (M38/02): its own key, written by the X or the first pin and by nothing else,
// and never cleared by the device's pins going away.

const KEY = "collie:pin-hint:v1";

function pane(id: string): AgentView {
  return {
    paneId: id,
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/collie",
    focused: false,
  };
}

describe("pin hint flag", () => {
  it("starts unretired with nothing stored, and a read writes nothing", () => {
    expect(pinHintRetired()).toBe(false);
    const { result } = renderHook(() => usePinHintRetired());
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("retires on the operator's act, under its own key, and survives a reload", () => {
    const { result } = renderHook(() => usePinHintRetired());
    act(() => retirePinHint());
    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    __reloadPinHint();
    expect(pinHintRetired()).toBe(true);
    // Nothing else was written beside it: not the pins store, not dash-prefs.
    expect(Object.keys(localStorage)).toEqual([KEY]);
  });

  it("is retired by the first pin, and stays retired after every pin is removed", () => {
    const herd = [pane("w1:p1")];
    setPinned(herd[0]!, true, herd);
    expect(pinHintRetired()).toBe(true);
    setPinned(herd[0]!, false, herd);
    __reloadPinHint();
    expect(pinHintRetired()).toBe(true);
  });

  it("is not retired by an unpin alone", () => {
    const herd = [pane("w1:p1")];
    setPinned(herd[0]!, false, herd);
    expect(pinHintRetired()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reads anything but its own value as still to show", () => {
    localStorage.setItem(KEY, "yes");
    __reloadPinHint();
    expect(pinHintRetired()).toBe(false);
  });

  it("shows only unretired, with no pin stored, on at least three rows", () => {
    expect(PIN_HINT_MIN_ROWS).toBe(3);
    expect(showsPinHint(false, 0, 3)).toBe(true);
    expect(showsPinHint(false, 0, 2)).toBe(false);
    expect(showsPinHint(false, 1, 10)).toBe(false);
    expect(showsPinHint(true, 0, 10)).toBe(false);
  });
});

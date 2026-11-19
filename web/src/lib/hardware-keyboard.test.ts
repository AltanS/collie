import { beforeEach, describe, expect, it } from "vitest";

import {
  __reloadHardwareKeyboard,
  __resetHardwareKeyboard,
  hasSeenHardwareKeyboard,
  isHardwareKeyPress,
  noteKeyPress,
} from "./hardware-keyboard";

const KEY = "collie:hardware-keyboard-seen:v1";
const PHYSICAL = { code: "KeyB", isComposing: false, keyCode: 66 } as const;

beforeEach(() => __resetHardwareKeyboard());

describe("isHardwareKeyPress", () => {
  it.each([
    ["a key that names its physical key", PHYSICAL, true],
    ["a modifier alone", { code: "ControlLeft", isComposing: false, keyCode: 17 }, true],
    ["an on-screen key with no code", { code: "", isComposing: false, keyCode: 0 }, false],
    ["a key inside a composition", { code: "KeyA", isComposing: true, keyCode: 65 }, false],
    ["keyCode 229 with no composition open", { code: "KeyA", isComposing: false, keyCode: 229 }, false],
  ])("%s", (_name, facts, expected) => {
    expect(isHardwareKeyPress(facts)).toBe(expected);
  });
});

describe("the remembered answer", () => {
  it("is not seen before any press, and a press that is not physical leaves it so", () => {
    expect(hasSeenHardwareKeyboard()).toBe(false);
    noteKeyPress({ code: "", isComposing: false, keyCode: 0 });
    noteKeyPress({ code: "KeyA", isComposing: true, keyCode: 65 });
    noteKeyPress({ code: "KeyA", isComposing: false, keyCode: 229 });
    expect(hasSeenHardwareKeyboard()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("is seen from the first physical press, and is stored", () => {
    noteKeyPress(PHYSICAL);
    expect(hasSeenHardwareKeyboard()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("survives a reload", () => {
    noteKeyPress(PHYSICAL);
    __reloadHardwareKeyboard();
    expect(hasSeenHardwareKeyboard()).toBe(true);
  });

  it("reads not seen from a store that holds anything else", () => {
    localStorage.setItem(KEY, "yes");
    __reloadHardwareKeyboard();
    expect(hasSeenHardwareKeyboard()).toBe(false);
  });

  it("does not write again after the first press", () => {
    noteKeyPress(PHYSICAL);
    localStorage.removeItem(KEY);
    noteKeyPress(PHYSICAL);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __reloadHardwareKeyboard,
  __resetHardwareKeyboard,
  hasSeenHardwareKeyboard,
  isHardwareKeyboardEvidence,
  isHardwareKeyPress,
  noteKeyPress,
} from "./hardware-keyboard";

// The on-screen keyboard's answer, which the module reads from hooks/use-keyboard.ts: one value to set.
const soft = vi.hoisted(() => ({ isUp: false }));
vi.mock("@/hooks/use-keyboard", () => ({ isSoftKeyboardUp: () => soft.isUp }));

const KEY = "collie:hardware-keyboard-seen:v2";
const PHYSICAL = { code: "KeyB", isComposing: false, keyCode: 66 } as const;

beforeEach(() => {
  soft.isUp = false;
  __resetHardwareKeyboard();
});

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

// THE STRICTER TEST (a phone's own keyboard once showed the hint while its owner typed). A press counts
// only when the on-screen keyboard is down AND its code is one an on-screen keyboard does not send.
describe("isHardwareKeyboardEvidence", () => {
  const press = (code: string, keyCode = 0) => ({ code, isComposing: false, keyCode });
  it.each([
    ["Enter with a code while the keyboard is up", press("Enter", 13), true, false],
    ["Backspace with a code", press("Backspace", 8), false, false],
    ["Backspace with a code, keyboard up", press("Backspace", 8), true, false],
    ["Digit1", press("Digit1", 49), false, false],
    ["Enter with the keyboard down", press("Enter", 13), false, false],
    ["Tab, Space and an arrow", press("Space", 32), false, false],
    ["ArrowLeft", press("ArrowLeft", 37), false, false],
    ["Shift alone", press("ShiftLeft", 16), false, false],
    ["MediaPlayPause", press("MediaPlayPause", 179), false, false],
    ["AudioVolumeUp", press("AudioVolumeUp", 175), false, false],
    ["BrowserBack", press("BrowserBack", 166), false, false],
    ["KeyA with the keyboard up", press("KeyA", 65), true, false],
    ["KeyA with it down", press("KeyA", 65), false, true],
    ["KeyZ with it down", press("KeyZ", 90), false, true],
    ["ControlLeft", press("ControlLeft", 17), false, true],
    ["AltRight", press("AltRight", 18), false, true],
    ["MetaLeft", press("MetaLeft", 91), false, true],
    ["Escape", press("Escape", 27), false, true],
    ["F1", press("F1", 112), false, true],
    ["F12", press("F12", 123), false, true],
    ["F13 is not one a keyboard needs", press("F13", 124), false, false],
    ["a code that is not a letter key", press("KeyAB", 65), false, false],
    ["no code", press(""), false, false],
    ["a letter inside a composition", { code: "KeyA", isComposing: true, keyCode: 65 }, false, false],
    ["a letter with keyCode 229", { code: "KeyA", isComposing: false, keyCode: 229 }, false, false],
  ])("%s", (_name, facts, isSoftKeyboardUp, expected) => {
    expect(isHardwareKeyboardEvidence({ facts, isSoftKeyboardUp })).toBe(expected);
  });
});

describe("the remembered answer", () => {
  it("does not take a code an on-screen keyboard fills in, and not any press while it is up", () => {
    noteKeyPress({ code: "Enter", isComposing: false, keyCode: 13 });
    noteKeyPress({ code: "Backspace", isComposing: false, keyCode: 8 });
    noteKeyPress({ code: "Digit1", isComposing: false, keyCode: 49 });
    soft.isUp = true;
    noteKeyPress(PHYSICAL);
    expect(hasSeenHardwareKeyboard()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    soft.isUp = false;
    noteKeyPress(PHYSICAL);
    expect(hasSeenHardwareKeyboard()).toBe(true);
  });

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

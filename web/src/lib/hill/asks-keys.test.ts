import { describe, expect, it } from "vitest";

import { askKeyAction, confirmsOnKey, isTypingTarget, type AskKeyPress } from "./asks-keys";

function press(key: string, over: Partial<AskKeyPress> = {}): AskKeyPress {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, typing: false, sheet: false, ...over };
}

describe("the keys of the ask screen", () => {
  it("moves with the arrows and j and k", () => {
    expect(askKeyAction(press("ArrowRight"))).toEqual({ kind: "next" });
    expect(askKeyAction(press("j"))).toEqual({ kind: "next" });
    expect(askKeyAction(press("ArrowLeft"))).toEqual({ kind: "previous" });
    expect(askKeyAction(press("k"))).toEqual({ kind: "previous" });
  });

  it("picks an answer with 1 to 9, and goes up with Escape", () => {
    expect(askKeyAction(press("1"))).toEqual({ kind: "pick", number: 1 });
    expect(askKeyAction(press("9"))).toEqual({ kind: "pick", number: 9 });
    expect(askKeyAction(press("0"))).toBeNull();
    expect(askKeyAction(press("Escape"))).toEqual({ kind: "up" });
  });

  it("does nothing while a field has the focus, a sheet is up, a modifier is held or a composition runs", () => {
    expect(askKeyAction(press("j", { typing: true }))).toBeNull();
    expect(askKeyAction(press("1", { sheet: true }))).toBeNull();
    expect(askKeyAction(press("Escape", { sheet: true }))).toBeNull();
    expect(askKeyAction(press("k", { metaKey: true }))).toBeNull();
    expect(askKeyAction(press("k", { ctrlKey: true }))).toBeNull();
    expect(askKeyAction(press("k", { altKey: true }))).toBeNull();
    expect(askKeyAction(press("j", { isComposing: true }))).toBeNull();
    expect(askKeyAction(press("1", { shiftKey: true }))).toBeNull();
  });

  it("confirms on Enter alone, not on Shift+Enter and not on a button", () => {
    const enter = { key: "Enter", shiftKey: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, onButton: false };
    expect(confirmsOnKey(enter)).toBe(true);
    expect(confirmsOnKey({ ...enter, shiftKey: true })).toBe(false);
    expect(confirmsOnKey({ ...enter, onButton: true })).toBe(false);
    expect(confirmsOnKey({ ...enter, isComposing: true })).toBe(false);
    expect(confirmsOnKey({ ...enter, key: "a" })).toBe(false);
  });

  it("knows which elements take typed text", () => {
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

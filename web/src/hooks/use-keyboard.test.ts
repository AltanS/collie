import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { keyboardLikelyOpen, nextKeyboardOpen, raisesKeyboard, useKeyboardOpen } from "./use-keyboard";

describe("keyboardLikelyOpen", () => {
  it("is closed when the height is unchanged", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });

  it("ignores small drops like the URL bar collapsing", () => {
    expect(keyboardLikelyOpen(800, 720)).toBe(false); // -80px
  });

  it("is open when the height drops past a keyboard-sized amount", () => {
    expect(keyboardLikelyOpen(800, 480)).toBe(true); // -320px
  });

  it("is closed again once the height returns to baseline", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYSTERESIS — the answer depends on where we were, not only on how far down we are.
//
// One threshold is right for gating a strip and wrong the moment layout hangs off the answer: a
// viewport hovering at the boundary (split screen, a floating keyboard, a predictive-text bar, a
// keyboard animating shut in steps) flips the boolean repeatedly, and each flip now moves a third of
// the screen. These pin the dead band between 100 and 150 in BOTH directions — a single-threshold
// "tidy-up" fails at least one of them whichever number it picks.
// ─────────────────────────────────────────────────────────────────────────────
describe("nextKeyboardOpen", () => {
  it("needs a keyboard-sized drop to open, and the URL bar is not one", () => {
    expect(nextKeyboardOpen(false, 800, 720)).toBe(false); // -80px
    expect(nextKeyboardOpen(false, 800, 660)).toBe(false); // -140px, still inside the dead band
    expect(nextKeyboardOpen(false, 800, 480)).toBe(true); // -320px
  });

  it("stays open across a drop that would not have opened it", () => {
    // The keyboard shrinking (a predictive-text bar collapsing, a split keyboard) must not be read
    // as the keyboard leaving. -140px is below the OPEN threshold and above the CLOSE one.
    expect(nextKeyboardOpen(true, 800, 660)).toBe(true);
    expect(nextKeyboardOpen(true, 800, 690)).toBe(true); // -110px
  });

  it("closes only once the height has come most of the way back", () => {
    expect(nextKeyboardOpen(true, 800, 720)).toBe(false); // -80px, back inside the closed band
    expect(nextKeyboardOpen(true, 800, 800)).toBe(false);
  });

  it("cannot strand the operator in a composing layout with no keyboard", () => {
    // `baseline` only ratchets UP, so a URL bar hiding raises it for the rest of the session. With
    // the close test at the same 150 as the open test, a genuinely-closed keyboard would sit inside
    // the dead band forever. The error is bounded by the URL bar's own height, which is under 100.
    const baselineRaisedByUrlBar = 880;
    expect(nextKeyboardOpen(true, baselineRaisedByUrlBar, 800)).toBe(false); // -80px
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STRANDED PANE (2026-10-24). On the operator's iPhone one pane sat in the composing layout with
// no keyboard on screen: the status line gone, the composer pressed against the home indicator.
// The height read "open" and nothing on screen could type. A soft keyboard needs a focused field,
// so the hook now answers open only with both; these pin that, and that focus alone is not enough.
// ─────────────────────────────────────────────────────────────────────────────
describe("useKeyboardOpen", () => {
  const listeners = new Set<() => void>();
  const vv = {
    width: 390,
    height: 844,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  const had = Object.getOwnPropertyDescriptor(window, "visualViewport");

  function setup() {
    vv.width = 390;
    vv.height = 844;
    listeners.clear();
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const field = document.createElement("textarea");
    const other = document.createElement("textarea");
    document.body.append(field, other);
    const renders: boolean[] = [];
    const hook = renderHook(() => {
      const open = useKeyboardOpen();
      renders.push(open);
      return open;
    });
    const resize = (height: number) => {
      vv.height = height;
      act(() => listeners.forEach((fn) => fn()));
    };
    return { field, other, hook, resize, renders };
  }

  afterEach(() => {
    document.body.replaceChildren();
    if (had) Object.defineProperty(window, "visualViewport", had);
    else Reflect.deleteProperty(window, "visualViewport");
  });

  it("is open while a field has focus and the height dropped by a keyboard", () => {
    const { field, hook, resize } = setup();
    act(() => field.focus());
    resize(460);
    expect(hook.result.current).toBe(true);
  });

  it("closes when the field loses focus even though the height stays low (the stranded pane)", () => {
    const { field, hook, resize } = setup();
    act(() => field.focus());
    resize(460);
    expect(hook.result.current).toBe(true);
    // The keyboard is gone, but iOS left the visual viewport short: the height alone still says open.
    act(() => field.blur());
    expect(hook.result.current).toBe(false);
  });

  it("does not open on a height drop with nothing focused (a ratcheted baseline)", () => {
    const { hook, resize } = setup();
    resize(1000); // a transient taller reading raises the baseline…
    resize(844); // …and the real height now reads 156px short of it
    expect(hook.result.current).toBe(false);
  });

  it("stays open while focus moves from one field to another under the keyboard", () => {
    const { field, other, hook, resize, renders } = setup();
    act(() => field.focus());
    resize(460);
    const from = renders.length;
    act(() => other.focus());
    // Every answer rendered across the move, not just the last: moving the caret between two fields
    // is not the keyboard leaving.
    expect(renders.slice(from).every(Boolean)).toBe(true);
    expect(hook.result.current).toBe(true);
  });

  it("is closed with focus and no height drop (a hardware keyboard)", () => {
    const { field, hook } = setup();
    act(() => field.focus());
    expect(hook.result.current).toBe(false);
  });
});

describe("raisesKeyboard", () => {
  it("is true for a field that types, false for controls and locked fields", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    const locked = document.createElement("textarea");
    locked.readOnly = true;
    expect(raisesKeyboard(document.createElement("textarea"))).toBe(true);
    expect(raisesKeyboard(text)).toBe(true);
    expect(raisesKeyboard(box)).toBe(false);
    expect(raisesKeyboard(locked)).toBe(false);
    expect(raisesKeyboard(document.createElement("button"))).toBe(false);
    // The app's search fields (ui/search-field.tsx, find-bar.tsx, space-overview.tsx) are inputs of
    // type search or of no type; a native <select> (settings) shows a picker, not a keyboard.
    const search = document.createElement("input");
    search.type = "search";
    expect(raisesKeyboard(search)).toBe(true);
    expect(raisesKeyboard(document.createElement("select"))).toBe(false);
    expect(raisesKeyboard(null)).toBe(false);
  });
});

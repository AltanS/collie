import { describe, expect, it } from "vitest";

import { ACTIONS } from "./actions";
import { anchorOf, capSize, HINT_MARGIN_PX, hintKeyCaps, placeHint, type Box } from "./hints";
import { buildKeymap } from "./keymap";
import type { UserShortcuts } from "./types";

const VIEWPORT = { width: 1440, height: 900 };
const CAP = { width: 20, height: 20 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe("placeHint", () => {
  it("centres the cap on the control's top right corner", () => {
    expect(placeHint({ box: box(100, 200, 144, 244), cap: CAP, viewport: VIEWPORT, clip: null })).toEqual({ left: 134, top: 190 });
  });

  it("keeps the cap inside the window with a margin, at every edge", () => {
    const corner = placeHint({ box: box(1400, 0, 1440, 40), cap: CAP, viewport: VIEWPORT, clip: null });
    expect(corner).toEqual({ left: 1440 - 20 - HINT_MARGIN_PX, top: HINT_MARGIN_PX });
    const low = placeHint({ box: box(0, 860, 40, 900), cap: { width: 40, height: 20 }, viewport: VIEWPORT, clip: null });
    expect(low).toEqual({ left: 20, top: 860 - 10 });
  });

  it("says none for a control with no box", () => {
    expect(placeHint({ box: box(10, 10, 10, 50), cap: CAP, viewport: VIEWPORT, clip: null })).toBe("none");
    expect(placeHint({ box: box(0, 0, 0, 0), cap: CAP, viewport: VIEWPORT, clip: null })).toBe("none");
  });

  it("says none for a control outside the window", () => {
    expect(placeHint({ box: box(1500, 100, 1544, 144), cap: CAP, viewport: VIEWPORT, clip: null })).toBe("none");
    expect(placeHint({ box: box(100, -80, 144, -36), cap: CAP, viewport: VIEWPORT, clip: null })).toBe("none");
  });

  it("says none for a control a scrolling ancestor clips away, and keeps the cap on the part that shows", () => {
    const strip = box(0, 0, 300, 40);
    expect(placeHint({ box: box(400, 0, 444, 40), cap: CAP, viewport: VIEWPORT, clip: strip })).toBe("none");
    expect(placeHint({ box: box(100, 0, 144, 40), cap: CAP, viewport: VIEWPORT, clip: strip })).toEqual({ left: 134, top: HINT_MARGIN_PX });
    // The centre is outside the strip: the control is seen in part, and a tap at its centre lands elsewhere.
    expect(placeHint({ box: box(270, 0, 330, 40), cap: CAP, viewport: VIEWPORT, clip: strip })).toBe("none");
  });
});

describe("capSize", () => {
  it("is one square for a single letter and widens for a named key", () => {
    expect(capSize(["g"])).toEqual({ width: 20, height: 20 });
    expect(capSize(["Shift", "N"]).width).toBeGreaterThan(capSize(["Shift"]).width);
  });
});

function keymapOf(user: UserShortcuts = {}) {
  return buildKeymap({ defaults: ACTIONS, user, mac: false });
}

describe("hintKeyCaps", () => {
  it("shows the first prefix key of the live keymap", () => {
    expect(hintKeyCaps({ keymap: keymapOf(), id: "open_actions" })).toEqual(["g"]);
    expect(hintKeyCaps({ keymap: keymapOf(), id: "pane_menu" })).toEqual(["m"]);
    expect(hintKeyCaps({ keymap: keymapOf(), id: "new_space" })).toEqual(["\u21e7N"]);
  });

  it("follows a key the person set, and shows its first prefix key when there are several", () => {
    expect(hintKeyCaps({ keymap: keymapOf({ open_actions: ["prefix+a"] }), id: "open_actions" })).toEqual(["a"]);
    expect(hintKeyCaps({ keymap: keymapOf({ settings: ["ctrl+k", "prefix+e", "prefix+f"] }), id: "settings" })).toEqual(["e"]);
  });

  it("shows nothing for an unbound action, and for one with only a direct key", () => {
    expect(hintKeyCaps({ keymap: keymapOf({ find: [] }), id: "find" })).toBeNull();
    expect(hintKeyCaps({ keymap: keymapOf({ find: ["ctrl+f"] }), id: "find" })).toBeNull();
    expect(hintKeyCaps({ keymap: keymapOf(), id: "rename_pane" })).toBeNull();
  });

  it("shows the digit of an indexed action", () => {
    const keymap = keymapOf();
    expect(hintKeyCaps({ keymap, id: "switch_tab", index: 1 })).toEqual(["1"]);
    expect(hintKeyCaps({ keymap, id: "switch_tab", index: 9 })).toEqual(["9"]);
    expect(hintKeyCaps({ keymap, id: "switch_tab", index: 10 })).toBeNull();
  });
});

describe("the anchor of a cap", () => {
  const button = box(100, 100, 144, 144);
  const glyph = box(112, 112, 132, 132);

  it("is the glyph of a control with no text whose box is more than 12px larger than its icon", () => {
    expect(anchorOf({ box: button, glyph })).toEqual(glyph);
  });

  it("is the glyph of a button spread wide around a small icon, the one wide in one direction only", () => {
    const wide = box(100, 100, 600, 130);
    expect(anchorOf({ box: wide, glyph: box(100, 105, 120, 125) })).toEqual(box(100, 105, 120, 125));
    expect(anchorOf({ box: box(100, 100, 144, 120), glyph: box(100, 100, 120, 120) })).toEqual(box(100, 100, 120, 120));
  });

  it("is the box when it is at most 12px larger than the icon, in both directions", () => {
    expect(anchorOf({ box: box(100, 100, 132, 132), glyph: box(110, 110, 130, 130) })).toEqual(box(100, 100, 132, 132));
  });

  it("is the glyph of a control that names its icon, whatever the box around it", () => {
    expect(anchorOf({ box: box(100, 100, 132, 132), glyph: box(104, 104, 128, 128), icon: true })).toEqual(box(104, 104, 128, 128));
  });

  it("is the box of a control with words, however small its icon", () => {
    expect(anchorOf({ box: box(100, 100, 400, 140), glyph: box(104, 110, 120, 126), hasText: true })).toEqual(box(100, 100, 400, 140));
  });

  it("is the box of a control with no icon", () => {
    expect(anchorOf({ box: button, glyph: null })).toEqual(button);
    expect(anchorOf({ box: button })).toEqual(button);
  });
});

describe("the place of a cap on an icon", () => {
  const button = box(300, 300, 344, 344);
  const glyph = box(312, 312, 332, 332);
  const icon = { box: button, glyph, cap: CAP, viewport: VIEWPORT, clip: null };
  const area = (at: { left: number; top: number }): Box => box(at.left, at.top, at.left + CAP.width, at.top + CAP.height);
  const meets = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  it("1: up and aside, the cap's bottom left corner 2px in on the icon's top right corner", () => {
    expect(placeHint(icon)).toEqual({ left: 330, top: 294 });
  });

  it("2: beside the icon, top aligned, 2px off its right edge, when up and aside has no room", () => {
    // The icon at the window's top edge: the cap would stand above the margin.
    const top = { ...icon, box: box(300, 0, 344, 44), glyph: box(312, 12, 332, 32) };
    expect(placeHint(top)).toEqual({ left: 334, top: 12 });
  });

  it("2: also when a text stands where the first place would be", () => {
    expect(placeHint({ ...icon, avoid: [box(325, 285, 400, 305)] })).toEqual({ left: 334, top: 312 });
  });

  it("3: below and aside, when the first two places meet a text", () => {
    const avoid = [box(325, 285, 400, 305), box(334, 305, 400, 328)];
    expect(placeHint({ ...icon, avoid })).toEqual({ left: 330, top: 330 });
  });

  it("4: on the icon's left, top aligned, when the right side is full", () => {
    const avoid = [box(325, 285, 400, 305), box(334, 305, 400, 328), box(325, 328, 400, 360)];
    expect(placeHint({ ...icon, avoid })).toEqual({ left: 290, top: 312 });
  });

  it("5: straight below the icon, aligned to its right edge, when the four places beside it are full", () => {
    const corner = { ...icon, box: box(0, 0, 44, 44), glyph: box(12, 12, 32, 32), corner: "top-left" as const };
    // Up and left leave the window, and a text stands at the right of the icon.
    expect(placeHint({ ...corner, avoid: [box(34, 0, 200, 40)] })).toEqual({ left: 12, top: 34 });
  });

  it("6: straight above when below is full too", () => {
    const low = { ...icon, avoid: [box(333, 285, 400, 305), box(334, 305, 400, 328), box(325, 328, 400, 360), box(280, 305, 312, 328), box(280, 280, 312, 340), box(300, 334, 350, 360)] };
    expect(placeHint(low)).toEqual({ left: 312, top: 290 });
  });

  it("7: the corner place, centred on the icon's corner, when no place is free", () => {
    const avoid = [box(0, 0, 1440, 900)];
    expect(placeHint({ ...icon, avoid })).toEqual({ left: 322, top: 302 });
  });

  it("holds the icon fully in view: no place meets it, beyond the 2px that join cap and icon", () => {
    for (const avoid of [[], [box(325, 285, 400, 305)], [box(325, 285, 400, 305), box(334, 305, 400, 328)]]) {
      const at = placeHint({ ...icon, avoid });
      if (at === "none") throw new Error("a place was expected");
      const inner = box(glyph.left + 2, glyph.top + 2, glyph.right - 2, glyph.bottom - 2);
      expect(meets(area(at), inner)).toBe(false);
    }
  });

  it("keeps every place inside the window with its margin", () => {
    const edge = { ...icon, box: box(1396, 0, 1440, 44), glyph: box(1408, 12, 1428, 32) };
    // Up is above the margin and the right side leaves the window: the cap goes on the icon's left.
    expect(placeHint(edge)).toEqual({ left: 1386, top: 12 });
  });

  it("mirrors the order for a control that asks for the top left: up-left, left, below-left, right", () => {
    const left = { ...icon, corner: "top-left" as const };
    expect(placeHint(left)).toEqual({ left: 294, top: 294 });
    expect(placeHint({ ...left, avoid: [box(280, 280, 320, 305)] })).toEqual({ left: 290, top: 312 });
    expect(placeHint({ ...left, avoid: [box(280, 280, 320, 305), box(280, 305, 312, 328)] })).toEqual({ left: 294, top: 330 });
    expect(placeHint({ ...left, avoid: [box(280, 280, 320, 305), box(280, 305, 312, 328), box(280, 328, 320, 360)] })).toEqual({ left: 334, top: 312 });
  });

  it("moves to the next place when a cap already placed is in the way", () => {
    expect(placeHint({ ...icon, placed: [area({ left: 330, top: 294 })] })).toEqual({ left: 330, top: 330 });
  });

  it("keeps the corner place for a control whose anchor is its box", () => {
    expect(placeHint({ box: box(100, 200, 144, 244), cap: CAP, viewport: VIEWPORT, clip: null, glyph: box(102, 202, 142, 242) })).toEqual({ left: 134, top: 190 });
    expect(placeHint({ box: box(100, 200, 400, 240), glyph: box(104, 210, 120, 226), hasText: true, cap: CAP, viewport: VIEWPORT, clip: null })).toEqual({ left: 390, top: 190 });
  });

  it("puts a box-anchored cap on the top left corner when the control asks", () => {
    expect(placeHint({ box: box(100, 100, 400, 140), cap: CAP, viewport: VIEWPORT, clip: null, corner: "top-left" })).toEqual({ left: 90, top: 90 });
  });

  it("clips on the icon's own box, and falls back to the control's when the icon is clipped away", () => {
    const strip = box(0, 0, 300, 40);
    const at = placeHint({ box: box(100, 0, 144, 40), glyph: box(110, 0, 130, 20), cap: CAP, viewport: VIEWPORT, clip: strip });
    expect(at).not.toBe("none");
  });
});

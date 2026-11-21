import { describe, expect, it } from "vitest";

import { ACTIONS } from "./actions";
import { capSize, HINT_MARGIN_PX, hintAction, hintKeyCaps, placeHint, type Box } from "./hints";
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

function keymapOf(user: UserShortcuts = {}, disabled: ReadonlySet<(typeof ACTIONS)[number]["id"]> = new Set()) {
  return buildKeymap({ defaults: ACTIONS, user, mac: false, disabled });
}

describe("hintKeyCaps", () => {
  it("shows the first prefix key of the live keymap", () => {
    expect(hintKeyCaps({ keymap: keymapOf(), id: "open_actions" })).toEqual(["g"]);
    expect(hintKeyCaps({ keymap: keymapOf(), id: "pane_settings" })).toEqual(["m"]);
    expect(hintKeyCaps({ keymap: keymapOf(), id: "new_space" })).toEqual(["Shift", "N"]);
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

  it("shows the key of the stand-in while the Actions palette is off, as the keymap resolves it", () => {
    const keymap = keymapOf({}, new Set(["open_actions"]));
    expect(hintAction({ keymap, id: "open_actions" })).toBe("switch_pane");
    expect(hintKeyCaps({ keymap, id: "open_actions" })).toEqual(["g"]);
    expect(keymap.prefixed.get("g")).toMatchObject({ action: "switch_pane" });
  });

  it("shows nothing for an action that is off with no stand-in", () => {
    expect(hintAction({ keymap: keymapOf({}, new Set(["settings"])), id: "settings" })).toBeNull();
  });
});

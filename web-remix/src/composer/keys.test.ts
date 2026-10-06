/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { composerKeyIntent, keysFor, SPECIAL_KEYS, specialKeyAllowed, specialKeyLabel } from "./keys";

const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean } = {}) =>
  composerKeyIntent({ key, ctrlKey: false, metaKey: false, isComposing: false, ...mods });

describe("composerKeyIntent", () => {
  test("Ctrl+Enter and Cmd+Enter send", () => {
    expect(press("Enter", { ctrlKey: true })).toBe("send");
    expect(press("Enter", { metaKey: true })).toBe("send");
  });

  test("a bare Enter is a newline, as in the React composer", () => {
    expect(press("Enter")).toBe("newline");
  });

  test("an IME composition never sends", () => {
    expect(press("Enter", { ctrlKey: true, isComposing: true })).toBe("none");
  });

  test("other keys do nothing", () => {
    expect(press("a")).toBe("none");
    expect(press("Escape", { ctrlKey: true })).toBe("none");
  });
});

describe("special keys row", () => {
  test("the row is Esc, Ctrl-C, the arrows, Tab and Enter, in wire names", () => {
    expect(SPECIAL_KEYS.map((k) => k.wire)).toEqual(["Escape", "ctrl+c", "Left", "Up", "Down", "Right", "Tab", "Enter"]);
  });

  test("each key sends exactly its wire name", () => {
    for (const key of SPECIAL_KEYS) expect(keysFor(key)).toEqual([key.wire]);
  });

  test("labels come from web's key labels", () => {
    const label = (wire: string) => specialKeyLabel(SPECIAL_KEYS.find((k) => k.wire === wire)!);
    expect(label("Escape")).toBe("Esc");
    expect(label("ctrl+c")).toBe("Ctrl C");
    expect(label("Tab")).toBe("Tab");
  });

  test("a key the multiplexer refuses is not offered", () => {
    const tab = SPECIAL_KEYS.find((k) => k.wire === "Tab")!;
    expect(specialKeyAllowed(tab, [])).toBe(true);
    expect(specialKeyAllowed(tab, ["Tab"])).toBe(false);
  });
});

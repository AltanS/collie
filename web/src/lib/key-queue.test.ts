import { describe, expect, it } from "vitest";

import { composeKey, isDangerKey, keyLabel, normalizeBaseChar } from "./key-queue";

describe("composeKey", () => {
  it("joins a modifier onto a base with the base verbatim", () => {
    expect(composeKey("ctrl", "g")).toBe("ctrl+g");
    expect(composeKey(null, "Down")).toBe("Down");
    // The exact strings the tray has always sent for shift — case preserved on the wire.
    expect(composeKey("shift", "Tab")).toBe("shift+Tab");
    expect(composeKey("shift", "Enter")).toBe("shift+Enter");
    expect(composeKey("shift", "7")).toBe("shift+7");
    expect(composeKey("ctrl", "Left")).toBe("ctrl+Left");
  });

  it("passes a base that already contains '+' through unchanged (no stacked modifier)", () => {
    expect(composeKey("shift", "ctrl+c")).toBe("ctrl+c");
    expect(composeKey("ctrl", "ctrl+d")).toBe("ctrl+d");
    expect(composeKey(null, "shift+tab")).toBe("shift+tab");
  });
});

describe("keyLabel", () => {
  it("labels chords, specials, and bare chars", () => {
    expect(keyLabel("ctrl+g")).toBe("Ctrl G");
    expect(keyLabel("shift+Tab")).toBe("⇧ Tab");
    expect(keyLabel("Escape")).toBe("Esc");
    expect(keyLabel("Enter")).toBe("⏎");
    expect(keyLabel("g")).toBe("G");
    expect(keyLabel("ctrl+c")).toBe("Ctrl C");
  });

  it("falls back to the token for plain multi-char keys", () => {
    expect(keyLabel("Down")).toBe("Down");
    expect(keyLabel("Tab")).toBe("Tab");
    expect(keyLabel("Space")).toBe("Space");
  });
});

describe("isDangerKey", () => {
  it("flags the interrupt/suspend/kill chords (ctrl+c IS danger on the queued path)", () => {
    expect(isDangerKey("ctrl+c")).toBe(true);
    expect(isDangerKey("ctrl+d")).toBe(true);
    expect(isDangerKey("ctrl+z")).toBe(true);
    expect(isDangerKey("CTRL+D")).toBe(true); // case-insensitive
  });

  it("leaves ordinary keys alone", () => {
    expect(isDangerKey("ctrl+g")).toBe(false);
    expect(isDangerKey("ctrl+l")).toBe(false);
    expect(isDangerKey("Down")).toBe(false);
    expect(isDangerKey("Enter")).toBe(false);
  });
});

describe("normalizeBaseChar", () => {
  it("lower-cases a single printable char", () => {
    expect(normalizeBaseChar("g")).toBe("g");
    expect(normalizeBaseChar("G")).toBe("g");
    expect(normalizeBaseChar("5")).toBe("5");
  });

  it("takes the LAST char of a multi-char input (paste / burst)", () => {
    expect(normalizeBaseChar("abc")).toBe("c");
    expect(normalizeBaseChar("aB")).toBe("b");
  });

  it("rejects empty, space, and non-printable input", () => {
    expect(normalizeBaseChar("")).toBeNull();
    expect(normalizeBaseChar(" ")).toBeNull();
    expect(normalizeBaseChar("\t")).toBeNull();
  });
});

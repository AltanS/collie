import { describe, expect, it } from "vitest";

import {
  composeKey,
  isDangerKey,
  keyLabel,
  modifierLabel,
  nextModMode,
  normalizeBaseChar,
} from "./key-queue";

describe("composeKey", () => {
  it("joins a single modifier onto a base with the base verbatim", () => {
    expect(composeKey(["ctrl"], "g")).toBe("ctrl+g");
    expect(composeKey([], "Down")).toBe("Down");
    // The exact strings the tray has always sent for shift — case preserved on the wire.
    expect(composeKey(["shift"], "Tab")).toBe("shift+Tab");
    expect(composeKey(["shift"], "Enter")).toBe("shift+Enter");
    expect(composeKey(["shift"], "7")).toBe("shift+7");
    expect(composeKey(["ctrl"], "Left")).toBe("ctrl+Left");
  });

  it("orders combined modifiers by MODIFIER_ORDER regardless of tap order", () => {
    expect(composeKey(["ctrl", "shift"], "p")).toBe("ctrl+shift+p");
    expect(composeKey(["shift", "ctrl"], "p")).toBe("ctrl+shift+p"); // same result, any order
    expect(composeKey(["alt"], "Up")).toBe("alt+Up");
    expect(composeKey(["shift", "alt", "ctrl"], "p")).toBe("ctrl+alt+shift+p"); // triple
  });

  it("de-dupes repeated modifiers", () => {
    expect(composeKey(["ctrl", "ctrl"], "g")).toBe("ctrl+g");
    expect(composeKey(["shift", "ctrl", "shift"], "p")).toBe("ctrl+shift+p");
  });

  it("empty modifiers returns the base unchanged", () => {
    expect(composeKey([], "Up")).toBe("Up");
    expect(composeKey([], "g")).toBe("g");
  });

  it("passes a base that already contains '+' through unchanged (never stacks onto a preset)", () => {
    expect(composeKey(["shift"], "ctrl+c")).toBe("ctrl+c");
    expect(composeKey(["ctrl", "shift"], "ctrl+c")).toBe("ctrl+c");
    expect(composeKey([], "shift+tab")).toBe("shift+tab");
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

  it("labels multi-modifier chords in leading order", () => {
    expect(keyLabel("ctrl+shift+p")).toBe("Ctrl ⇧ P");
    expect(keyLabel("ctrl+alt+shift+p")).toBe("Ctrl Alt ⇧ P");
    expect(keyLabel("alt+Up")).toBe("Alt Up");
  });

  it("labels the cmd/super modifiers the grammar allows but the tray doesn't surface", () => {
    expect(keyLabel("cmd+k")).toBe("Cmd K");
    expect(keyLabel("super+l")).toBe("Super L");
  });

  it("treats a lone '+' (no leading modifier) as a base char", () => {
    expect(keyLabel("+")).toBe("+");
  });

  it("falls back to the token for plain multi-char keys", () => {
    expect(keyLabel("Down")).toBe("Down");
    expect(keyLabel("Tab")).toBe("Tab");
    expect(keyLabel("Space")).toBe("Space");
  });
});

describe("modifierLabel", () => {
  it("labels each surfaced modifier", () => {
    expect(modifierLabel("ctrl")).toBe("Ctrl");
    expect(modifierLabel("alt")).toBe("Alt");
    expect(modifierLabel("shift")).toBe("⇧");
  });
});

describe("nextModMode", () => {
  it("cycles off → once → locked → off", () => {
    expect(nextModMode("off")).toBe("once");
    expect(nextModMode("once")).toBe("locked");
    expect(nextModMode("locked")).toBe("off");
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

import { describe, expect, it } from "vitest";

import { menuKeyFor, parseKeyHintFooter } from "./menu-hints";

// The SHARED menu helpers — the half of the generic modal contract every adapter reuses. Pinned here
// rather than in a harness's own test file precisely because a second adapter will lean on them.

describe("menuKeyFor", () => {
  it("maps the footer's key vocabulary onto Herdr keys", () => {
    expect(menuKeyFor("Enter")).toBe("Enter");
    expect(menuKeyFor("enter")).toBe("Enter");
    expect(menuKeyFor("Esc")).toBe("Escape");
    expect(menuKeyFor("Escape")).toBe("Escape");
    expect(menuKeyFor("Tab")).toBe("Tab");
    expect(menuKeyFor("shift+tab")).toBe("shift+tab");
    expect(menuKeyFor("s")).toBe("s");
    expect(menuKeyFor("↑")).toBe("Up");
    expect(menuKeyFor("↓")).toBe("Down");
    expect(menuKeyFor("←")).toBe("Left");
    expect(menuKeyFor("→")).toBe("Right");
    expect(menuKeyFor("ctrl+g")).toBe("ctrl+g");
  });

  // .adr/0009: a digit in the /model picker confirms AND persists the default. It is a valid Herdr
  // key, so nothing downstream would reject it — the ban has to be here.
  it("NEVER maps a digit, however the footer spells it", () => {
    for (const token of ["1", "2", "9", "10", "0"]) {
      expect(menuKeyFor(token), token).toBeNull();
    }
  });

  it("declines prose, unsupported keys, and uppercase letters", () => {
    for (const token of ["Set model", "PageUp", "Home", "Delete", "S", "", "ctrl+shift+p"]) {
      expect(menuKeyFor(token), token).toBeNull();
    }
  });
});

describe("parseKeyHintFooter", () => {
  it("splits on the spaced middle dot and keeps the verb as the label", () => {
    expect(
      parseKeyHintFooter("Enter to set as default · s to use this session only · Esc to cancel"),
    ).toEqual([
      { label: "Set as default", keys: ["Enter"] },
      { label: "Use this session only", keys: ["s"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
  });

  it("skips a segment whose key isn't sendable, keeping the rest", () => {
    expect(parseKeyHintFooter("PageUp to scroll · Esc to cancel")).toEqual([
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
  });

  it("returns nothing for a single segment or a segment-less line", () => {
    expect(parseKeyHintFooter("Esc to cancel")).toEqual([]);
    expect(parseKeyHintFooter("some ordinary output")).toEqual([]);
    expect(parseKeyHintFooter("model · branch · 42% ctx")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { menuKeyFor, parseKeyHintFooter, readKeyHintFooter } from "./menu-hints";

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

describe("readKeyHintFooter — a footer the TERMINAL broke at column 0", () => {
  // The screen `claude--menu-effort-slider--w60-ultracode.txt` captured: a 60-column pane whose
  // dialog rules run edge to edge, a footer drawn at indent 3, and a second row at indent 0 because
  // the next word did not fit. Claude's own flex wrap keeps the indent; this break is the
  // terminal's, and the reader has to take it or lose two thirds of the footer.
  const RULE = "▔".repeat(60);
  // 57 of 60 columns used, so `only` (4 more, plus a space) could not follow on that row.
  const FIRST = "   ←/→ to adjust · Enter to confirm · s for this session ";
  const REST = "only · Esc to cancel";

  it("joins the indent-0 continuation when the row above had no room for its first word", () => {
    expect(FIRST.length).toBe(57);
    expect(FIRST.trimEnd().length + 1 + "only".length).toBeGreaterThan(RULE.length);

    const footer = readKeyHintFooter([RULE, "   Effort", "", FIRST, REST]);
    expect(footer).not.toBeNull();
    expect(footer!.text).toBe(
      "←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
    );
    expect(footer!.startLine).toBe(3);
    expect(footer!.endLine).toBe(4);
    expect(footer!.actions).toEqual([
      { label: "Confirm", keys: ["Enter"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
  });

  it("refuses the same two rows when the first one had room for `only`", () => {
    // The only edit is the first row's length: 48 of 60 columns, so a terminal wrapping here would
    // have put `only` on that row. A row at indent 0 under it is therefore somebody else's output,
    // not this footer's tail, and the group is refused — leaving the indent-0 row alone, which is
    // not a footer either (`only` is not a hint).
    const short = "   ←/→ to adjust · Enter to confirm · s for this";
    expect(short.length).toBe(48);
    expect(short.length + 1 + "only".length).toBeLessThan(RULE.length);
    expect(readKeyHintFooter([RULE, "   Effort", "", short, REST])).toBeNull();
  });

  it("refuses an indent-0 continuation that is prose rather than hint text", () => {
    // Soft-wrapped by the arithmetic, and still not part of the footer: one of its `·`-separated
    // segments is not a `<key> to|for <verb>` hint, so the group is refused whole the way every
    // other non-hint row is. The exception widens WHICH rows may join, never WHAT may join.
    const prose = "unrelated output · more output";
    expect(FIRST.trimEnd().length + 1 + "unrelated".length).toBeGreaterThan(RULE.length);
    expect(readKeyHintFooter([RULE, "   Effort", "", FIRST, prose])).toBeNull();
  });

  it("still refuses a continuation at some other indent than the block's", () => {
    // Indent 0 is the terminal's break. Indent 1 is not, however little room the row above had.
    expect(readKeyHintFooter([RULE, "   Effort", "", FIRST, " " + REST])).toBeNull();
  });
});

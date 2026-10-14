import { describe, expect, it } from "vitest";

import { trailingTaskChecklistStart } from "./task-checklist";

// The checklist Claude Code 2.1.299 draws under a dialog's footer. See task-checklist.ts.

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

/** The tail of the real screen that first showed it: footer, blank, header, four rows. */
const REAL = [
  FOOTER,
  "",
  "  4 tasks (3 done, 1 in progress, 0 open)",
  "  ✔ Hygiene pass on CC plan",
  "  ✔ Triage, inbox, pending CI, context baseline",
  "  ✔ Land CC-17 after delve reindex",
  "  ◼ Orient, slice, explore, build, land, checkpoint",
];

/** A screen whose last rows are `header` then `rows`, under a footer. */
const screen = (header: string, ...rows: string[]): string[] => [FOOTER, "", header, ...rows];

describe("trailingTaskChecklistStart", () => {
  it("finds the header of the real screen's checklist", () => {
    expect(trailingTaskChecklistStart(REAL)).toBe(2);
  });

  it("clause 1: every row below the header is a checklist row, and at least one is there", () => {
    expect(trailingTaskChecklistStart([...REAL, "● Wrote the file"])).toBeNull();
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 open)"))).toBeNull();
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 open)", "", ""))).toBeNull();
    expect(trailingTaskChecklistStart([...REAL, "", "   ", ""])).toBe(2);
  });

  it("clause 2: the header is the whole row, with `in progress` optional and `task` singular allowed", () => {
    expect(trailingTaskChecklistStart(screen("  4 tasks (3 done, 1 in progress, 0 open)", "  ✔ a", "  ✔ b", "  ✔ c", "  ◼ d"))).toBe(
      2,
    );
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 open)", "  ◻ Hotel step"))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  1 task (0 done, 1 open)", "  ◻ Hotel step"))).toBe(2);
    const long = screen(
      "  8 tasks (2 done, 1 in progress, 5 open)",
      "  ◼ Juliet step",
      "  ◻ Kilo step",
      "  ◻ Lima step",
      "  ◻ Mike step",
      "  ◻ November step",
      "   … +1 pending, 2 completed",
    );
    expect(trailingTaskChecklistStart(long)).toBe(2);
  });

  it("clause 2: rejects a row that only looks like a header", () => {
    for (const header of [
      "  4 tasks (3 done)",
      "We have 4 tasks (3 done, 1 open) left.",
      "4 tasks remaining",
      "  4 tasks (3 done, 1 open, 0 open)",
    ]) {
      expect(trailingTaskChecklistStart(screen(header, "  ✔ a", "  ✔ b", "  ✔ c", "  ◻ d")), header).toBeNull();
    }
  });

  it("clause 3a: a state glyph, one space and text, any indent, trailing padding allowed", () => {
    expect(trailingTaskChecklistStart(screen("  1 tasks (1 done, 0 open)", "  ✔ Hygiene pass on CC plan"))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 in progress, 0 open)", "  ◼ Juliet step         "))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 open)", "  ◻ Kilo step"))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  1 tasks (0 done, 1 open)", "◻ Kilo step"))).toBe(2);
  });

  it("clause 3a: rejects rows that are not checklist rows", () => {
    for (const row of ["  ☐ Colour", "● Wrote the file", "  ⎿ done", "  ✔", "  ✔   ", "  ✔  two spaces", "←  ☐ Colour  ☐ Size  ✔ Submit  →"]) {
      expect(trailingTaskChecklistStart(screen("  1 tasks (1 done, 0 open)", row)), row).toBeNull();
    }
  });

  it("clause 3b: the overflow row counts what is not listed", () => {
    expect(trailingTaskChecklistStart(screen("  3 tasks (2 done, 1 open)", "  ◻ a", "   … +2 completed"))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  4 tasks (3 done, 1 in progress, 0 open)", "  ◼ a", "   … +3 completed"))).toBe(2);
    expect(trailingTaskChecklistStart(screen("  3 tasks (0 done, 2 in progress, 1 open)", "  ◻ a", "   … +2 in progress"))).toBe(2);
  });

  it("clause 3b: rejects rows that only look like an overflow row", () => {
    for (const row of ["… more", "   … 2 completed", "   … +2 done"]) {
      expect(trailingTaskChecklistStart(screen("  3 tasks (2 done, 1 open)", "  ◻ a", row)), row).toBeNull();
    }
  });

  it("clause 4: the counts must agree with the header, state by state and in total", () => {
    // 3 done, 1 in progress, 0 open, 4 in all: each count off by one.
    const rows = ["  ✔ a", "  ✔ b", "  ✔ c", "  ◼ d"];
    for (const header of [
      "  4 tasks (2 done, 1 in progress, 1 open)",
      "  4 tasks (4 done, 0 in progress, 0 open)",
      "  4 tasks (3 done, 0 in progress, 1 open)",
      "  4 tasks (3 done, 2 in progress, 0 open)",
      "  4 tasks (3 done, 1 in progress, 1 open)",
      "  5 tasks (3 done, 1 in progress, 0 open)",
      "  3 tasks (3 done, 1 in progress, 0 open)",
      "  4 tasks (3 done, 1 open)",
    ]) {
      expect(trailingTaskChecklistStart(screen(header, ...rows)), header).toBeNull();
    }
    // The overflow's counts are part of the tally: one short, or one over, is a mismatch.
    expect(trailingTaskChecklistStart(screen("  3 tasks (2 done, 1 open)", "  ◻ a", "   … +1 completed"))).toBeNull();
    expect(trailingTaskChecklistStart(screen("  3 tasks (2 done, 1 open)", "  ◻ a", "   … +2 completed, 1 pending"))).toBeNull();
  });

  it("clause 5: a header that is the first non-blank row of the buffer is not taken", () => {
    expect(trailingTaskChecklistStart(["  1 tasks (0 done, 1 open)", "  ◻ Hotel step"])).toBeNull();
    expect(trailingTaskChecklistStart(["", "  ", "  1 tasks (0 done, 1 open)", "  ◻ Hotel step"])).toBeNull();
  });

  it("returns null for an empty buffer and for one with no checklist", () => {
    expect(trailingTaskChecklistStart([])).toBeNull();
    expect(trailingTaskChecklistStart(["", "  "])).toBeNull();
    expect(trailingTaskChecklistStart([FOOTER])).toBeNull();
  });
});

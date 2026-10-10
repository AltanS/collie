import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyExpectedPrompt } from "../../../../../bridge/prompt-binding";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import {
  composerPrompt,
  draft,
  isBoxRow,
  isDialogOrModalRow,
  isRuleRow,
  locate,
  statusLines,
  stripChrome,
} from "./composer";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function loadFixture(name: string): StyledLine[] {
  const raw = readFileSync(join(PANES_DIR, name), "utf8");
  return splitLines(parseAnsi(raw));
}

const linesOf = (rows: string[]): StyledLine[] => splitLines(parseAnsi(rows.join("\n")));

const COMPOSER_FIXTURES = [
  "pi--v110-idle.txt",
  "pi--v110-idle-default-footer.txt",
  "pi--v110-draft.txt",
  "pi--v110-draft-multiline.txt",
  "pi--v110-slash-palette.txt",
  "pi--v110-working.txt",
  "pi--v110-narrow-idle.txt",
] as const;

const DIALOG_MODAL_FIXTURES = [
  "pi--v110-core-selector.txt",
  "pi--v110-single.txt",
  "pi--v110-single-desc.txt",
  "pi--v110-single-moved.txt",
  "pi--v110-single-editor-open.txt",
  "pi--v110-single-narrow.txt",
  "pi--v110-multi.txt",
  "pi--v110-multi-ticked.txt",
  "pi--v110-multi-moved.txt",
  "pi--v110-multi-pointer-other.txt",
  "pi--v110-multi-editor-open.txt",
  "pi--v110-tabs-single.txt",
  "pi--v110-tabs-single-recorded.txt",
  "pi--v110-tabs-multi.txt",
  "pi--v110-tabs-compact.txt",
  "pi--v110-tabs-editor-open.txt",
  "pi--v110-review-incomplete.txt",
  "pi--v110-review-complete.txt",
] as const;

describe("pi composer scanner — corpus matrix", () => {
  describe("found on every composer capture", () => {
    it.each(COMPOSER_FIXTURES)("%s is recognized as a composer frame", (name) => {
      const lines = loadFixture(name);
      const box = locate(lines);
      expect(box, `Expected ${name} to be located as a composer`).not.toBeNull();
      expect(box!.top).toBeLessThan(box!.bottom);
      expect(box!.firstDraftRow).toBe(box!.top + 1);
      expect(box!.draftEnd).toBe(box!.bottom);
      expect(box!.footerStart).toBeLessThan(box!.footerEnd);
    });
  });

  describe("null on every dialog / modal capture", () => {
    it.each(DIALOG_MODAL_FIXTURES)("%s yields null (dialog or modal owns screen)", (name) => {
      const lines = loadFixture(name);
      expect(locate(lines), `Expected ${name} to return null for locate`).toBeNull();
      expect(draft(lines), `Expected ${name} to return null for draft`).toBeNull();
      expect(statusLines(lines), `Expected ${name} to return [] for statusLines`).toEqual([]);
      expect(composerPrompt(lines), `Expected ${name} to return null for composerPrompt`).toBeNull();
    });
  });
});

describe("pi composer scanner — individual captures", () => {
  it("pi--v110-idle.txt: idle composer with operator powerbar footer", () => {
    const lines = loadFixture("pi--v110-idle.txt");
    const box = locate(lines)!;
    expect(box).toEqual({
      top: 0,
      firstDraftRow: 1,
      bottom: 2,
      draftEnd: 2,
      footerStart: 3,
      footerEnd: 4,
      palette: false,
      paletteStart: undefined,
      paletteEnd: undefined,
    });
    expect(draft(lines)).toBeNull();
    const status = statusLines(lines);
    expect(status).toHaveLength(1);
    expect(lineText(status[0]!)).toContain("⎇ main");
    expect(composerPrompt(lines)).toBe("─".repeat(120));
    expect(stripChrome(lines)).toHaveLength(0);
  });

  it("pi--v110-idle-default-footer.txt: idle composer with 2-row default footer", () => {
    const lines = loadFixture("pi--v110-idle-default-footer.txt");
    const box = locate(lines)!;
    expect(box).toEqual({
      top: 0,
      firstDraftRow: 1,
      bottom: 2,
      draftEnd: 2,
      footerStart: 3,
      footerEnd: 5,
      palette: false,
      paletteStart: undefined,
      paletteEnd: undefined,
    });
    expect(draft(lines)).toBeNull();
    const status = statusLines(lines);
    expect(status).toHaveLength(2);
    expect(lineText(status[0]!)).toContain("~/projects/pi-demo (main)");
    expect(lineText(status[1]!)).toContain("0.0%/0 (auto)");
    expect(composerPrompt(lines)).toBe("─".repeat(120));
    expect(stripChrome(lines)).toHaveLength(0);
  });

  it("pi--v110-draft.txt: single-line draft", () => {
    const lines = loadFixture("pi--v110-draft.txt");
    const box = locate(lines)!;
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(2);
    expect(draft(lines)).toBe("Add unit tests for the parser");
    expect(statusLines(lines)).toHaveLength(1);
    expect(composerPrompt(lines)).toBe("─".repeat(120));
    expect(stripChrome(lines)).toHaveLength(0);
  });

  it("pi--v110-draft-multiline.txt: multi-line draft joined with space", () => {
    const lines = loadFixture("pi--v110-draft-multiline.txt");
    const box = locate(lines)!;
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(3);
    expect(box.firstDraftRow).toBe(1);
    expect(box.draftEnd).toBe(3);
    expect(draft(lines)).toBe("Add unit tests for the parser and verify edge cases");
    expect(statusLines(lines)).toHaveLength(1);
    expect(composerPrompt(lines)).toBe("─".repeat(120));
    expect(stripChrome(lines)).toHaveLength(0);
  });

  it("pi--v110-slash-palette.txt: slash palette open below composer bottom rule", () => {
    const lines = loadFixture("pi--v110-slash-palette.txt");
    const box = locate(lines)!;
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(2);
    expect(box.palette).toBe(true);
    expect(box.paletteStart).toBe(3);
    expect(box.paletteEnd).toBe(9);
    expect(box.footerStart).toBe(9);
    expect(box.footerEnd).toBe(10);
    expect(draft(lines)).toBe("/");
    expect(statusLines(lines)).toHaveLength(1);
    // Slash palette has 6 rows + 1 footer row = 7 non-blank rows below bottom rule > 5,
    // so composerPrompt returns null to prevent bridge 409
    expect(composerPrompt(lines)).toBeNull();
    expect(stripChrome(lines)).toHaveLength(0);
  });

  it("pi--v110-working.txt: composer while agent is working", () => {
    const lines = loadFixture("pi--v110-working.txt");
    const box = locate(lines)!;
    expect(box.top).toBe(6);
    expect(box.bottom).toBe(8);
    expect(draft(lines)).toBeNull();
    expect(statusLines(lines)).toHaveLength(1);
    expect(composerPrompt(lines)).toBe("─".repeat(120));
    // stripChrome leaves the transcript lines (0..4) and drops blank separator 5 + composer
    const kept = stripChrome(lines);
    expect(kept).toHaveLength(5);
    expect(kept.map(lineText).some((t) => t.includes("Working"))).toBe(true);
  });

  it("pi--v110-narrow-idle.txt: composer at narrow terminal width (50 cols)", () => {
    const lines = loadFixture("pi--v110-narrow-idle.txt");
    const box = locate(lines)!;
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(2);
    expect(draft(lines)).toBeNull();
    expect(statusLines(lines)).toHaveLength(1);
    expect(composerPrompt(lines)).toBe("─".repeat(50));
    expect(stripChrome(lines)).toHaveLength(0);
  });
});

describe("pi composer scanner — prompt binding verification", () => {
  it.each([
    "pi--v110-idle.txt",
    "pi--v110-idle-default-footer.txt",
    "pi--v110-draft.txt",
    "pi--v110-draft-multiline.txt",
    "pi--v110-working.txt",
    "pi--v110-narrow-idle.txt",
  ])("%s: composerPrompt verifies successfully against pane text via bridge", (name) => {
    const lines = loadFixture(name);
    const prompt = composerPrompt(lines);
    expect(prompt).not.toBeNull();

    const rawText = lines.map(lineText).join("\n");
    const result = verifyExpectedPrompt(rawText, prompt!);
    expect(result, `verifyExpectedPrompt failed on ${name}`).toEqual({ ok: true });
  });

  it("tolerates pasted horizontal rules inside the draft (15-rule)", () => {
    const rule20 = "─".repeat(20);
    const border = "─".repeat(120);
    const lines = linesOf([
      "transcript row",
      border,
      "Reply with only OK.",
      rule20,
      "some text",
      rule20,
      "end",
      border,
      "⎇ master │ 0%",
      "cpa-vps │ profile-flash · off",
    ]);

    expect(locate(lines)).not.toBeNull();
    expect(draft(lines)).toBe(`Reply with only OK. ${rule20} some text ${rule20} end`);
  });

  it("composerPrompt returns null when slash palette rows exceed the 6-row tail window", () => {
    const lines = loadFixture("pi--v110-slash-palette.txt");
    expect(composerPrompt(lines)).toBeNull();
  });
});

describe("pi composer scanner — edge cases and fail-closed behavior", () => {
  it("empty buffer returns null / unchanged", () => {
    expect(locate([])).toBeNull();
    expect(draft([])).toBeNull();
    expect(statusLines([])).toEqual([]);
    expect(composerPrompt([])).toBeNull();
    const empty: StyledLine[] = [];
    expect(stripChrome(empty)).toBe(empty);
  });

  it("trailing blank lines are stripped before locating", () => {
    const lines = loadFixture("pi--v110-idle.txt");
    const padded = [...lines, ...linesOf(["   ", "   "])];
    const box = locate(padded)!;
    expect(box).not.toBeNull();
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(2);
  });

  it("conservatism: stripChrome returns the identical array reference when no composer is found", () => {
    const lines = loadFixture("pi--v110-single.txt");
    const stripped = stripChrome(lines);
    expect(stripped).toBe(lines);
  });

  it("refuses a frame with mismatched border rule lengths", () => {
    const mismatched = linesOf(["─".repeat(120), "draft text", "─".repeat(80), "status row"]);
    expect(locate(mismatched)).toBeNull();
  });

  it("refuses a frame when the footer contains a box border row", () => {
    const invalid = linesOf(["─".repeat(80), "draft text", "─".repeat(80), "╭── modal box ──╮"]);
    expect(locate(invalid)).toBeNull();
  });

  it("refuses a frame when draft rows contain dialog key hints", () => {
    const invalid = linesOf(["─".repeat(80), "  Enter to select • Esc to cancel", "─".repeat(80), "status row"]);
    expect(locate(invalid)).toBeNull();
  });

  it("refuses a frame when draft rows contain numbered options", () => {
    const invalid = linesOf(["─".repeat(80), "> 1. First option", "─".repeat(80), "status row"]);
    expect(locate(invalid)).toBeNull();
  });

  it("refuses a frame when draft rows contain questionnaire tab bar", () => {
    const invalid = linesOf(["─".repeat(80), " ←  ▣  Auth   ▢  Deploy   ✓ Review  → ", "─".repeat(80), "status row"]);
    expect(locate(invalid)).toBeNull();
  });

  it("refuses slash palette if the draft does not begin with '/'", () => {
    const invalid = linesOf(["─".repeat(80), "hello world", "─".repeat(80), "→ settings  Settings menu", "⎇ main │ status"]);
    expect(locate(invalid)).toBeNull();
  });

  it("tolerates scrolled editor border indicators in rules", () => {
    const scrolled = linesOf(["───── ↑ 3 more ─────", "middle text", "───── ↓ 1 more ─────", "status row"]);
    const box = locate(scrolled);
    expect(box).not.toBeNull();
    expect(box!.top).toBe(0);
    expect(box!.bottom).toBe(2);
    expect(draft(scrolled)).toBe("middle text");
  });
});

describe("isRuleRow / isBoxRow / isDialogOrModalRow helpers", () => {
  it("isRuleRow recognizes valid horizontal rules", () => {
    expect(isRuleRow("─".repeat(8))).toBe(true);
    expect(isRuleRow("─".repeat(120))).toBe(true);
    expect(isRuleRow("───── ↑ 2 more ─────")).toBe(true);
    expect(isRuleRow("───── ↓ 5 more ─────")).toBe(true);

    expect(isRuleRow("─".repeat(7))).toBe(false);
    expect(isRuleRow("── hello ──")).toBe(false);
    expect(isRuleRow("")).toBe(false);
  });

  it("isBoxRow recognizes box-drawing border rows", () => {
    expect(isBoxRow("╭───")).toBe(true);
    expect(isBoxRow("╰───")).toBe(true);
    expect(isBoxRow("┌───")).toBe(true);
    expect(isBoxRow("└───")).toBe(true);
    expect(isBoxRow("│ body │")).toBe(true);
    expect(isBoxRow("├───")).toBe(true);

    expect(isBoxRow("⎇ main │ 0%")).toBe(false);
    expect(isBoxRow("~/projects/pi-demo (main)")).toBe(false);
    expect(isBoxRow("0.0%/0 (auto)")).toBe(false);
  });

  it("isDialogOrModalRow recognizes dialog and modal patterns", () => {
    expect(isDialogOrModalRow("Esc to cancel")).toBe(true);
    expect(isDialogOrModalRow("Esc to go back")).toBe(true);
    expect(isDialogOrModalRow("Escape/Ctrl+C to cancel")).toBe(true);
    expect(isDialogOrModalRow("Enter to select • Esc to cancel")).toBe(true);
    expect(isDialogOrModalRow("↑↓ navigate • Space to tick")).toBe(true);
    expect(isDialogOrModalRow("←→ tabs • Enter submit • Esc cancel")).toBe(true);
    expect(isDialogOrModalRow("> 1. bun")).toBe(true);
    expect(isDialogOrModalRow("  [x] 1. ESLint")).toBe(true);
    expect(isDialogOrModalRow("Your answer (an option number...):")).toBe(true);
    expect(isDialogOrModalRow("Review your answers")).toBe(true);

    expect(isDialogOrModalRow("Add unit tests for the parser")).toBe(false);
    expect(isDialogOrModalRow("/model")).toBe(false);
    expect(isDialogOrModalRow("⎇ main │ 0%")).toBe(false);
  });
});

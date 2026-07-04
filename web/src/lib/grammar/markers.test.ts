import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { classifyFooter, isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";

// The shared lexing primitives every Claude-Code grammar leans on (chrome, prompt-select, and — in
// T3 — history segmentation). Small and pure; these pin the exact edge cases the matchers rely on.

describe("lineText / isBlank", () => {
  it("joins a line's segment text and detects blank lines", () => {
    const [a, b] = splitLines(parseAnsi("\x1b[31mred\x1b[0m text\n"));
    expect(lineText(a!)).toBe("red text");
    expect(isBlank(lineText(b!))).toBe(true); // the trailing blank line
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("x")).toBe(false);
  });
});

describe("isHorizontalRule", () => {
  it("matches a whole line of box-drawing / dashed rule glyphs", () => {
    expect(isHorizontalRule("─".repeat(40))).toBe(true);
    expect(isHorizontalRule("╌".repeat(30))).toBe(true);
    expect(isHorizontalRule("  ──────  ")).toBe(true); // surrounding spaces ignored
  });

  it("rejects ordinary text, option rows, and ASCII rules", () => {
    expect(isHorizontalRule("Do you want to proceed?")).toBe(false);
    expect(isHorizontalRule("1. Yes")).toBe(false);
    expect(isHorizontalRule("----")).toBe(false); // ASCII dashes are NOT rules (markdown/code)
    expect(isHorizontalRule("── collie upgrades ──")).toBe(false); // embedded label ⇒ not a pure rule
  });
});

describe("isBoxBorder", () => {
  it("matches a long rule run even with an embedded label (input-box top border)", () => {
    expect(isBoxBorder("─".repeat(40))).toBe(true);
    expect(isBoxBorder("─".repeat(30) + " collie upgrades " + "──")).toBe(true);
  });

  it("rejects ordinary text and short dashes", () => {
    expect(isBoxBorder("hello world")).toBe(false);
    expect(isBoxBorder("a ── b")).toBe(false); // only two dashes
  });
});

describe("classifyFooter", () => {
  it("maps each dialog family off its footer hint bar", () => {
    expect(classifyFooter("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe("select");
    expect(classifyFooter("Enter to confirm · Esc to cancel")).toBe("trust");
    expect(classifyFooter("Esc to cancel · Tab to amend")).toBe("permission");
    expect(classifyFooter("Esc to cancel · Tab to amend · ctrl+e to explain")).toBe("permission");
    expect(classifyFooter("ctrl+g to edit in  nano  · ~/.claude/plans/velvet-toasting-turtle.md")).toBe("plan");
  });

  it("returns null for a non-footer line (statusline / hint / prose)", () => {
    expect(classifyFooter("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBeNull();
    expect(classifyFooter("← for agents")).toBeNull();
    expect(classifyFooter("Do you want to proceed?")).toBeNull();
  });
});

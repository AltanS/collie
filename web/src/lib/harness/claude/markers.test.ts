import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import {
  classifyFooter,
  isBlank,
  isBoxBorder,
  isHorizontalRule,
  isInputBoxTopBorder,
  isMultiStepHeader,
  lineText,
} from "./markers";

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
    expect(isBoxBorder("─".repeat(30) + " collie upgrades ──")).toBe(true);
  });

  it("rejects ordinary text and short dashes", () => {
    expect(isBoxBorder("hello world")).toBe(false);
    expect(isBoxBorder("a ── b")).toBe(false); // only two dashes
  });

  // Bug #76: a bare border's old test required 20+ consecutive rule glyphs ANYWHERE on the line.
  // That's width-dependent — Herdr's shared grid follows the narrowest attached client, so a split
  // pane's border can render well under 20 glyphs. The shape test (a trimmed line of nothing but
  // U+2500, no absolute floor beyond BARE_BORDER_MIN=8) passes at any realistic width.
  it("matches a bare border at a narrow 19-glyph pane width (below the old 20-glyph floor)", () => {
    expect(isBoxBorder("─".repeat(19))).toBe(true);
  });

  it("matches a bare border at exactly the 8-glyph floor", () => {
    expect(isBoxBorder("─".repeat(8))).toBe(true);
  });

  it("rejects a bare run below the floor (too short to be a real border)", () => {
    expect(isBoxBorder("───")).toBe(false); // 3 glyphs — a plausible prose separator, not a border
    expect(isBoxBorder("─".repeat(7))).toBe(false); // one under the floor
  });

  // Claude Code sometimes splices a session/job name into the input box's TOP border. The old test
  // required 20+ UNBROKEN glyphs, but a label splits the run in two, so neither flank reached 20 even
  // at a normal pane width — this is bug #76's second failure mode. Observed real capture: flanks
  // 5/2 at 43 columns.
  it("matches a labelled border (rule + embedded label + rule)", () => {
    expect(isBoxBorder("───── some job name ──")).toBe(true);
    expect(isBoxBorder("───── japanese technical troubleshooting ──")).toBe(true); // observed 5/2 flanks
  });

  // MUST-NOT cases, round 1: text shaped just enough like a labelled border to worry about, but not
  // one. Em/en dash and friends are a DIFFERENT glyph from the U+2500 isBoxBorder now requires, so
  // these fail outright rather than merely failing a flank-length floor.
  it("rejects em-dash prose (a different glyph than the border rule, U+2014 not U+2500)", () => {
    expect(isBoxBorder("— quoted aside —")).toBe(false);
  });

  it("rejects an en-dash bullet (different glyph, and no trailing run at all)", () => {
    expect(isBoxBorder("– list item")).toBe(false);
  });

  it("rejects a sentence that merely contains dashes", () => {
    expect(isBoxBorder("foo — bar — baz")).toBe(false);
    expect(isBoxBorder("This works — mostly — except here")).toBe(false);
  });

  it("rejects ASCII markdown rules (a different glyph than U+2500 entirely)", () => {
    expect(isBoxBorder("---")).toBe(false);
    expect(isBoxBorder("===")).toBe(false);
    expect(isBoxBorder("--- some heading ---")).toBe(false);
  });

  // MUST-NOT cases, round 2 (post field-review): isBoxBorder used to delegate its bare-border check to
  // isHorizontalRule, which is deliberately generic (menu.ts and the select detectors need its WIDE
  // box-drawing/dash family) and strips ALL interior whitespace before testing. That combination was
  // unsafe here: a spaced-out prose separator or a table divider could compact into "nothing but rule
  // glyphs" and pass as an input-box border. isBoxBorder is now decoupled from isHorizontalRule and
  // restricted to the ONE glyph (U+2500) Claude actually draws its input box with.
  it("rejects a spaced-out em-dash separator (compacts to a rule under the old shared test)", () => {
    expect(isBoxBorder("— — —")).toBe(false);
  });

  it("rejects a spaced-out CJK dash-label separator (horizontal bar U+2015, not U+2500)", () => {
    expect(isBoxBorder("―― 中略 ――")).toBe(false);
  });

  it("rejects a spaced table divider (vertical bars, not the border glyph)", () => {
    expect(isBoxBorder("│ │ │")).toBe(false);
  });

  it("rejects a labelled shape whose \"label\" is itself only more rule glyphs", () => {
    expect(isBoxBorder("── ─ ──")).toBe(false);
  });

  it("rejects a labelled shape whose \"label\" is only whitespace", () => {
    expect(isBoxBorder("──   ──")).toBe(false);
  });

  it("rejects a dialog border with corner glyphs — Claude never draws its input box that way", () => {
    expect(isBoxBorder("╭──────╮")).toBe(false);
    expect(isBoxBorder("╰──────╯")).toBe(false);
  });
});

// Round-3 finding: traced against the bundled Claude Code renderer's own label-placement math, a
// labelled top border can render with EITHER flank as short as ONE glyph (the renderer's own
// `Math.max(1, …)` clamp) — isBoxBorder's 2-glyph floor is too strict for that specific line.
// isInputBoxTopBorder is the ONLY place that looser floor applies (locateInputBox step (e)); every
// other call site keeps isBoxBorder's stricter test.
describe("isInputBoxTopBorder", () => {
  it("accepts everything isBoxBorder already accepts", () => {
    expect(isInputBoxTopBorder("─".repeat(19))).toBe(true);
    expect(isInputBoxTopBorder("─".repeat(8))).toBe(true);
    expect(isInputBoxTopBorder("───── japanese technical troubleshooting ──")).toBe(true);
  });

  it("accepts a labelled border with a 1-glyph RIGHT flank (renderer's align:center/end clamp)", () => {
    expect(isInputBoxTopBorder("──── fast mode ─")).toBe(true);
  });

  it("accepts a labelled border with a 1-glyph LEFT flank", () => {
    expect(isInputBoxTopBorder("─ fast mode ────")).toBe(true);
  });

  it("still rejects text that isn't the border glyph at all (wrong codepoint)", () => {
    expect(isInputBoxTopBorder("— quoted aside —")).toBe(false); // em dash, not U+2500
    expect(isInputBoxTopBorder("―― 中略 ――")).toBe(false); // horizontal bar, not U+2500
    expect(isInputBoxTopBorder("│ │ │")).toBe(false); // vertical bar, not U+2500
    expect(isInputBoxTopBorder("foo — bar — baz")).toBe(false);
    expect(isInputBoxTopBorder("---")).toBe(false); // ASCII, not U+2500
  });

  it("still rejects a rule-only or whitespace-only \"label\" even with 1-glyph flanks", () => {
    expect(isInputBoxTopBorder("─ ─ ─")).toBe(false); // the "label" is itself a rule glyph
    expect(isInputBoxTopBorder("─   ─")).toBe(false); // the "label" is only whitespace
  });

  it("still rejects a corner-glyph dialog border", () => {
    expect(isInputBoxTopBorder("╭──────╮")).toBe(false);
  });
});

// Round-4 finding: a labelled border's per-flank minimums alone don't rule out a total width narrower
// than any bare border the renderer can actually draw — the renderer draws a box's top and bottom
// border at the SAME width, and the bare bottom border already requires >= BARE_BORDER_MIN (8), so a
// labelled top border below that total is a physically impossible shape. Both isBoxBorder (2-glyph
// flank floor) and isInputBoxTopBorder (1-glyph flank floor) share this width floor.
describe("labelled borders below the shared total-width floor", () => {
  it("rejects a 5-column labelled border by BOTH predicates, even at loose 1-glyph flanks", () => {
    expect(isBoxBorder("─ x ─")).toBe(false);
    expect(isInputBoxTopBorder("─ x ─")).toBe(false);
  });

  it("rejects a 7-column labelled border by BOTH predicates, even at strict 2-glyph flanks", () => {
    expect(isBoxBorder("── x ──")).toBe(false);
    expect(isInputBoxTopBorder("── x ──")).toBe(false);
  });

  it("accepts an 8-column labelled border (exactly at the floor) with strict 2-glyph flanks", () => {
    expect(isBoxBorder("── ab ──")).toBe(true);
    expect(isInputBoxTopBorder("── ab ──")).toBe(true);
  });

  it("accepts an 8-column labelled border with loose 1-glyph flanks, but ONLY via the loose predicate", () => {
    expect(isBoxBorder("─ abcd ─")).toBe(false); // flanks are 1 glyph — isBoxBorder still wants 2
    expect(isInputBoxTopBorder("─ abcd ─")).toBe(true); // meets the shared floor at 8 columns total
  });

  // Round-5 finding: the floor above must be measured in DISPLAY CELLS (text-width.ts's `displayWidth`),
  // not UTF-16 `.length` — a CJK label undercounts in `.length` (1 code unit per glyph, 2 cells) and a
  // combining-mark label overcounts (base + mark are 2 code units but render as ONE cell). CJK session
  // labels are real in this deployment (observed live labels are sometimes Japanese), so the
  // undercount direction is the one that actually bites: a legitimate 8-cell CJK-labelled border must
  // not be rejected just because its `.length` reads as only 6.
  it("accepts an 8-cell CJK-labelled border whose .length (6) reads under the floor", () => {
    const border = "─ 中文 ─"; // 1 + 1 + 2 + 2 + 1 + 1 = 8 display cells, but .length is only 6
    expect(border.length).toBe(6);
    expect(isInputBoxTopBorder(border)).toBe(true); // 1-glyph flanks — loose predicate only
  });

  it("rejects a 6-cell CJK-labelled border by both predicates", () => {
    const border = "─ 中 ─"; // 1 + 1 + 2 + 1 + 1 = 6 display cells
    expect(isBoxBorder(border)).toBe(false);
    expect(isInputBoxTopBorder(border)).toBe(false);
  });

  it("rejects a combining-mark label whose .length (8) reads at the floor but is really 7 cells", () => {
    const border = "── é ──"; // "é" as base "e" + combining acute — one visual cell, two UTF-16 units
    expect(border.length).toBe(8);
    expect(isBoxBorder(border)).toBe(false);
    expect(isInputBoxTopBorder(border)).toBe(false);
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

describe("isMultiStepHeader", () => {
  it("detects a multi-question stepper (≥2 checkbox/step glyphs on one line)", () => {
    expect(isMultiStepHeader("←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →")).toBe(true);
    expect(isMultiStepHeader("☐ A  ☐ B")).toBe(true);
  });

  it("does not flag a single-question chip or ordinary prose", () => {
    expect(isMultiStepHeader(" ☐ Color Theme ")).toBe(false); // single-question dialog's lone chip
    expect(isMultiStepHeader("How should I approach the work?")).toBe(false);
    expect(isMultiStepHeader("1. Plan first")).toBe(false);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import {
  answerEditorDraft,
  answerEditorPrompt,
  answerEditorPromptRegion,
  locateAnswerEditor,
} from "./answer-editor";
import { detectDialogFrame, parseTabBar } from "./frame";
import { modalOnScreen } from "./modal";
import { detectSingleQuestion, detectSingleQuestionRegion } from "./question";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function loadLines(name: string): StyledLine[] {
  const content = readFileSync(join(PANES_DIR, name), "utf8");
  return splitLines(parseAnsi(content));
}

const DIALOG_FIXTURES = [
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
];

const COMPOSER_FIXTURES = [
  "pi--v110-idle.txt",
  "pi--v110-idle-default-footer.txt",
  "pi--v110-draft.txt",
  "pi--v110-draft-multiline.txt",
  "pi--v110-narrow-idle.txt",
  "pi--v110-slash-palette.txt",
  "pi--v110-working.txt",
];

// ---------------------------------------------------------------------------------------------
// 1. Frame Recognition (frame.ts)
// ---------------------------------------------------------------------------------------------

describe("frame.ts — detectDialogFrame", () => {
  it.each(DIALOG_FIXTURES)("recognises dialog frame on %s", (name) => {
    const lines = loadLines(name);
    const frame = detectDialogFrame(lines);
    expect(frame).not.toBeNull();
    expect(frame!.topRule).toBeLessThan(frame!.bottomRule);
    expect(frame!.footerStart).toBeLessThan(frame!.bottomRule);
    expect(frame!.accentColor).toBeTruthy();
  });

  it.each(COMPOSER_FIXTURES)("declines composer fixture %s", (name) => {
    const lines = loadLines(name);
    expect(detectDialogFrame(lines)).toBeNull();
  });

  it("declines pi core selector (/model) because its rules are not accent-coloured and its footer is not a question dialog's", () => {
    const lines = loadLines("pi--v110-core-selector.txt");
    expect(detectDialogFrame(lines)).toBeNull();
  });

  it("detects editorOpen correctly", () => {
    expect(detectDialogFrame(loadLines("pi--v110-single-editor-open.txt"))!.editorOpen).toBe(true);
    expect(detectDialogFrame(loadLines("pi--v110-multi-editor-open.txt"))!.editorOpen).toBe(true);
    expect(detectDialogFrame(loadLines("pi--v110-tabs-editor-open.txt"))!.editorOpen).toBe(true);

    expect(detectDialogFrame(loadLines("pi--v110-single.txt"))!.editorOpen).toBe(false);
    expect(detectDialogFrame(loadLines("pi--v110-tabs-single.txt"))!.editorOpen).toBe(false);
  });

  it("handles narrow terminal wrapped footer", () => {
    const frame = detectDialogFrame(loadLines("pi--v110-single-narrow.txt"))!;
    expect(frame).not.toBeNull();
    expect(frame.footerStart).toBe(9);
    expect(frame.footerEnd).toBe(10);
    expect(frame.footerText).toBe(
      "↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel",
    );
  });

  describe("tab bar parsing and active chip style reading", () => {
    it("reads normal tab bar with Auth active", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-tabs-single.txt"))!;
      expect(frame.tabBar).toBeDefined();
      const tb = frame.tabBar!;
      expect(tb.compact).toBe(false);
      expect(tb.isReviewActive).toBe(false);
      expect(tb.chips).toHaveLength(3);
      expect(tb.chips[0]).toEqual({
        index: 0,
        label: "Auth",
        answered: false,
        active: true,
        compact: false,
      });
      expect(tb.chips[1]!.active).toBe(false);
      expect(tb.chips[2]!.active).toBe(false);
      expect(tb.reviewChip.active).toBe(false);
      expect(tb.activeChipIndex).toBe(0);
    });

    it("reads recorded answer mark ▣ on Auth tab", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-tabs-single-recorded.txt"))!;
      const tb = frame.tabBar!;
      expect(tb.chips[0]!.answered).toBe(true);
      expect(tb.chips[0]!.label).toBe("Auth");
      expect(tb.chips[0]!.active).toBe(true);
      expect(tb.chips[1]!.answered).toBe(false);
    });

    it("reads Features active in multi tab page", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-tabs-multi.txt"))!;
      const tb = frame.tabBar!;
      expect(tb.chips[0]!.active).toBe(false);
      expect(tb.chips[0]!.answered).toBe(true);
      expect(tb.chips[1]!.active).toBe(true);
      expect(tb.chips[1]!.answered).toBe(false);
      expect(tb.activeChipIndex).toBe(1);
    });

    it("reads compact tab bar with 9 numbered chips", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-tabs-compact.txt"))!;
      const tb = frame.tabBar!;
      expect(tb.compact).toBe(true);
      expect(tb.chips).toHaveLength(9);
      expect(tb.chips[0]!.label).toBe("1");
      expect(tb.chips[0]!.active).toBe(true);
      expect(tb.chips[0]!.compact).toBe(true);
      expect(tb.chips[8]!.label).toBe("9");
      expect(tb.reviewChip.compact).toBe(true);
      expect(tb.reviewChip.label).toBe("✓");
    });

    it("reads Review active on complete review", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-review-complete.txt"))!;
      const tb = frame.tabBar!;
      expect(tb.isReviewActive).toBe(true);
      expect(tb.reviewChip.active).toBe(true);
      expect(tb.chips.every((c) => !c.active)).toBe(true);
      expect(tb.chips.every((c) => c.answered)).toBe(true);
    });

    it("reads Review active on incomplete review", () => {
      const frame = detectDialogFrame(loadLines("pi--v110-review-incomplete.txt"))!;
      const tb = frame.tabBar!;
      expect(tb.isReviewActive).toBe(true);
      expect(tb.reviewChip.active).toBe(true);
      expect(tb.chips[0]!.answered).toBe(true);
      expect(tb.chips[1]!.answered).toBe(false);
      expect(tb.chips[2]!.answered).toBe(false);
    });

    it("tolerates top and bottom rule length mismatch caused by terminal resize", () => {
      const lines = loadLines("pi--v110-single.txt");
      const mutated = lines.map((l, i) => {
        // Truncate the top rule to simulate an earlier narrower viewport before resize
        if (i === 0) {
          return {
            segments: [{ text: "─".repeat(20), bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false, fg: l.segments[0]!.fg }],
          };
        }
        return l;
      });
      const frame = detectDialogFrame(mutated);
      expect(frame).not.toBeNull();
      expect(frame!.topRule).toBe(0);
    });

    it("mutation: refuses tab bar with two active chips (two segments with bg)", () => {
      const lines = loadLines("pi--v110-tabs-single.txt");
      const tabLine = lines[1]!;
      // Add bg to the second chip as well
      const mutatedSegments = tabLine.segments.map((seg) => {
        if (seg.text.includes("Features")) {
          return Object.assign({}, seg, { bg: "rgb(29,29,29)" });
        }
        return seg;
      });
      const mutatedLine = { ...tabLine, segments: mutatedSegments };
      expect(parseTabBar(mutatedLine, 1)).toBeNull();

      // Mutated full buffer also declines frame
      const mutatedBuffer = [...lines];
      mutatedBuffer[1] = mutatedLine;
      expect(detectDialogFrame(mutatedBuffer)).toBeNull();
    });

    it("mutation: refuses corrupt tab bar missing arrows", () => {
      const lines = loadLines("pi--v110-tabs-single.txt");
      const noArrows = {
        ...lines[1]!,
        segments: lines[1]!.segments.map((s) =>
          Object.assign({}, s, { text: s.text.replace("←", " ").replace("→", " ") }),
        ),
      };
      expect(parseTabBar(noArrows, 1)).toBeNull();
    });
  });

  it("declines scrolled-up dialog with output below status row", () => {
    const base = loadLines("pi--v110-single.txt");
    const scrolled = [
      ...base,
      ...splitLines(parseAnsi("user message in transcript\nmore output")),
    ];
    expect(detectDialogFrame(scrolled)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Free-Answer Editor (answer-editor.ts)
// ---------------------------------------------------------------------------------------------

describe("answer-editor.ts", () => {
  it.each([
    "pi--v110-single-editor-open.txt",
    "pi--v110-multi-editor-open.txt",
    "pi--v110-tabs-editor-open.txt",
  ])("locates answer editor on %s", (name) => {
    const lines = loadLines(name);
    const editor = locateAnswerEditor(lines);
    expect(editor).not.toBeNull();
    expect(editor!.firstInputRow).toBeLessThanOrEqual(editor!.lastInputRow);
    expect(editor!.innerTopRule).toBeLessThan(editor!.firstInputRow);
    expect(editor!.innerBottomRule).toBeGreaterThan(editor!.lastInputRow);
    expect(editor!.promptText).toContain("Your answer");
  });

  it("reads prompt text on single-editor-open", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    const editor = locateAnswerEditor(lines)!;
    expect(editor.promptText).toBe(
      "Your answer (an option number or label picks that option):",
    );
  });

  it("returns null for draft on clean empty capture", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    expect(answerEditorDraft(lines)).toBeNull();
  });

  it("reads typed draft and strips software caret / whitespace", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    const editor = locateAnswerEditor(lines)!;
    // Mutate the editor content line to simulate typed input with cursor
    const mutated = [...lines];
    mutated[editor.firstInputRow] = {
      segments: [{ text: " my-custom-answer▏   ", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(answerEditorDraft(mutated)).toBe("my-custom-answer");
  });

  it("reads multiline wrapped draft", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    const editor = locateAnswerEditor(lines)!;
    // Insert a continuation row
    const row1 = {
      segments: [{ text: " first line of answer", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    const row2 = {
      segments: [{ text: " second line of answer", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    const mutated = [
      ...lines.slice(0, editor.firstInputRow),
      row1,
      row2,
      ...lines.slice(editor.firstInputRow + 1),
    ];
    expect(answerEditorDraft(mutated)).toBe(
      "first line of answer second line of answer",
    );
  });

  it("answerEditorPrompt sits within 6 rows of buffer tail", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    const editor = locateAnswerEditor(lines)!;
    const tailDistance = lines.length - 1 - editor.lastInputRow;
    expect(tailDistance).toBeLessThanOrEqual(6);
  });

  it("answerEditorPromptRegion provides prompt boundaries", () => {
    const lines = loadLines("pi--v110-single-editor-open.txt");
    const region = answerEditorPromptRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.promptText).toBe(
      "Your answer (an option number or label picks that option):",
    );
    expect(region!.startLine).toBeLessThanOrEqual(region!.endLine);
  });

  it("declines when editor is not open", () => {
    expect(locateAnswerEditor(loadLines("pi--v110-single.txt"))).toBeNull();
    expect(answerEditorDraft(loadLines("pi--v110-single.txt"))).toBeNull();
    expect(answerEditorPrompt(loadLines("pi--v110-single.txt"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Single-Select Question Lift (question.ts)
// ---------------------------------------------------------------------------------------------

describe("question.ts — detectSingleQuestion", () => {
  it("lifts plain single question (pi--v110-single.txt)", () => {
    const lines = loadLines("pi--v110-single.txt");
    const region = detectSingleQuestionRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(0);

    const model = region!.model;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Which package manager do you want to use?");
    expect(model.options).toHaveLength(4);

    expect(model.options[0]).toEqual({
      label: "bun",
      keys: ["1", "Enter"],
    });
    expect(model.options[1]).toEqual({
      label: "npm",
      keys: ["2", "Enter"],
    });
    expect(model.options[2]).toEqual({
      label: "pnpm",
      keys: ["3", "Enter"],
    });
    expect(model.options[3]).toEqual({
      label: "yarn",
      keys: ["4", "Enter"],
    });

    // "Type something." is never an option, but sets customInput
    expect(model.options.some((o) => o.label.includes("Type something"))).toBe(
      false,
    );
    expect(model.customInput).toBe(true);
  });

  it("lifts single question with descriptions (pi--v110-single-desc.txt)", () => {
    const lines = loadLines("pi--v110-single-desc.txt");
    const model = detectSingleQuestion(lines)!;
    expect(model).not.toBeNull();
    expect(model.question).toBe("Which database provider should we use?");
    expect(model.options).toHaveLength(4);

    expect(model.options[0]).toEqual({
      label: "PostgreSQL",
      description: "Relational SQL database with ACID transactions",
      keys: ["1", "Enter"],
    });
    expect(model.options[1]).toEqual({
      label: "SQLite",
      description: "Lightweight serverless embedded database",
      keys: ["2", "Enter"],
    });
    expect(model.options[2]).toEqual({
      label: "Redis",
      description: "In-memory key-value data store and cache",
      keys: ["3", "Enter"],
    });
    expect(model.options[3]).toEqual({
      label: "ClickHouse",
      description: "Column-oriented analytical DBMS",
      keys: ["4", "Enter"],
    });
  });

  it("lifts single question in narrow terminal (pi--v110-single-narrow.txt)", () => {
    const lines = loadLines("pi--v110-single-narrow.txt");
    const model = detectSingleQuestion(lines)!;
    expect(model).not.toBeNull();
    expect(model.options).toHaveLength(4);
    expect(model.options[0]!.label).toBe("bun");
  });

  describe("identity and signature contract (ADR 0080)", () => {
    it("moved pointer preserves coreSignature and promptsSameIdentity, but changes signature", () => {
      const desc = detectSingleQuestion(loadLines("pi--v110-single-desc.txt"))!;
      const moved = detectSingleQuestion(
        loadLines("pi--v110-single-moved.txt"),
      )!;

      expect(desc).not.toBeNull();
      expect(moved).not.toBeNull();

      // Labels and keys match
      expect(desc.options).toEqual(moved.options);

      // Core signatures match (pointer independent)
      expect(desc.coreSignature).toBe(moved.coreSignature);
      expect(promptsSameIdentity(desc, moved)).toBe(true);

      // Signatures differ because the pointer "> " moved from row 1 to row 2
      expect(desc.signature).not.toBe(moved.signature);
      expect(promptsEqual(desc, moved)).toBe(false);
    });

    it("signature changes when question or options change", () => {
      const a = detectSingleQuestion(loadLines("pi--v110-single.txt"))!;
      const b = detectSingleQuestion(loadLines("pi--v110-single-desc.txt"))!;
      expect(a.signature).not.toBe(b.signature);
      expect(a.coreSignature).not.toBe(b.coreSignature);
      expect(promptsSameIdentity(a, b)).toBe(false);
    });
  });

  describe("refusals and boundary conditions", () => {
    it("refuses when editor is open", () => {
      expect(
        detectSingleQuestion(loadLines("pi--v110-single-editor-open.txt")),
      ).toBeNull();
    });

    it("refuses questionnaires with tab bars", () => {
      expect(detectSingleQuestion(loadLines("pi--v110-tabs-single.txt"))).toBeNull();
      expect(
        detectSingleQuestion(loadLines("pi--v110-tabs-compact.txt")),
      ).toBeNull();
    });

    it("refuses multi-select dialogs", () => {
      expect(detectSingleQuestion(loadLines("pi--v110-multi.txt"))).toBeNull();
      expect(
        detectSingleQuestion(loadLines("pi--v110-multi-ticked.txt")),
      ).toBeNull();
    });

    it("refuses composer fixtures", () => {
      for (const name of COMPOSER_FIXTURES) {
        expect(detectSingleQuestion(loadLines(name))).toBeNull();
      }
    });

    it("refuses scrolled-up dialog", () => {
      const base = loadLines("pi--v110-single.txt");
      const scrolled = [
        ...base,
        ...splitLines(parseAnsi("user typed something\nand scrolled")),
      ];
      expect(detectSingleQuestion(scrolled)).toBeNull();
    });

    it("mutation: refuses dialog with >9 options", () => {
      // Create a simulated single dialog with 10 options
      const header = "────────────────────────────────────────";
      const q = " Pick a number:";
      const opts = Array.from(
        { length: 10 },
        (_, i) => `  ${i + 1}. Option ${i + 1}`,
      );
      opts.push("  11. Type something.");
      const footer =
        "  ↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel";
      const status = "⎇ main";
      const raw = [
        `\u001b[38;2;235;203;139m${header}\u001b[0m`,
        q,
        "",
        ...opts,
        "",
        footer,
        `\u001b[38;2;235;203;139m${header}\u001b[0m`,
        status,
      ].join("\n");
      const lines = splitLines(parseAnsi(raw));
      expect(detectSingleQuestion(lines)).toBeNull();
    });

    it("mutation: refuses non-consecutive numbering", () => {
      const base = loadLines("pi--v110-single.txt");
      const mutated = [...base];
      // Change option 3 to option 9
      mutated[5] = {
        segments: [{ text: "  9. pnpm", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
      };
      expect(detectSingleQuestion(mutated)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Modal Gate (modal.ts)
// ---------------------------------------------------------------------------------------------

describe("modal.ts — modalOnScreen", () => {
  it.each(DIALOG_FIXTURES)(
    "returns true on pi question dialog %s",
    (name) => {
      const lines = loadLines(name);
      expect(modalOnScreen(lines)).toBe(true);
    },
  );

  it("returns true on pi core selector modal (/model)", () => {
    const lines = loadLines("pi--v110-core-selector.txt");
    expect(modalOnScreen(lines)).toBe(true);
  });

  it.each(COMPOSER_FIXTURES)("returns false on composer fixture %s", (name) => {
    const lines = loadLines(name);
    expect(modalOnScreen(lines)).toBe(false);
  });

  it("returns false on empty screen or whitespace", () => {
    expect(modalOnScreen([])).toBe(false);
    expect(modalOnScreen(splitLines(parseAnsi("   \n\n  ")))).toBe(false);
  });

  it("returns false on scrolled-up modal", () => {
    const base = loadLines("pi--v110-core-selector.txt");
    const scrolled = [
      ...base,
      ...splitLines(parseAnsi("user resumed chat\nnext command")),
    ];
    expect(modalOnScreen(scrolled)).toBe(false);
  });

  describe("footer mutation tests", () => {
    const modalFrame = (footer: string) => {
      const rule = "────────────────────────────────────────";
      const raw = [
        rule,
        " modal content line",
        "",
        `  ${footer}`,
        rule,
        "⎇ main",
      ].join("\n");
      return splitLines(parseAnsi(raw));
    };

    it.each([
      "↑↓ navigate • Enter to select • Esc to cancel",
      "Enter to select · Escape/Ctrl+C to cancel",
      "Enter to select · Esc close",
      "Enter to submit • Esc to go back",
      "←→ tabs • Enter submit • Esc cancel",
    ])("%s ⇒ true", (footer) => {
      expect(modalOnScreen(modalFrame(footer))).toBe(true);
    });

    it.each([
      // Missing escape verb
      "↑↓ navigate • Enter to select • Esc",
      // Mid-sentence Esc rather than closing hint
      "Esc to cancel • Enter to select",
      // Bare prose with no separator
      "Esc to cancel",
      // Other keys without Esc
      "↑↓ navigate • Enter to select",
      "Enter select · Ctrl+S set as default",
    ])("%s ⇒ false", (footer) => {
      expect(modalOnScreen(modalFrame(footer))).toBe(false);
    });
  });

  it("returns false on foreign harness fixtures", () => {
    const foreign = readdirSync(PANES_DIR)
      .filter((f) => !f.startsWith("pi--") && f.endsWith(".txt"))
      .slice(0, 50);
    expect(foreign.length).toBeGreaterThan(0);
    for (const name of foreign) {
      expect(modalOnScreen(loadLines(name))).toBe(false);
    }
  });
});

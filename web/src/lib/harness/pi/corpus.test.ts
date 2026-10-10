import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

interface FixtureExpectation {
  name: string;
  expectedTailAnchor: (tailRows: string[], allRows: string[]) => boolean;
  description: string;
}

const EXPECTATIONS: FixtureExpectation[] = [
  // Composer fixtures (8)
  {
    name: "pi--v110-idle.txt",

    description: "idle composer with powerbar operator footer",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("⎇ main")) && tail.some((r) => r.includes("──")),
  },
  {
    name: "pi--v110-idle-default-footer.txt",

    description: "idle composer launched with --no-extensions and question.ts, showing default 2-row footer",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("0.0%/0 (auto)")) && tail.some((r) => r.includes("~/projects/pi-demo")),
  },
  {
    name: "pi--v110-draft.txt",

    description: "single-line draft in composer",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("Add unit tests for the parser")) && tail.some((r) => r.includes("⎇ main")),
  },
  {
    name: "pi--v110-draft-multiline.txt",

    description: "multi-line draft in composer",
    expectedTailAnchor: (tail) =>
      tail.some((r) => r.includes("Add unit tests for the parser")) &&
      tail.some((r) => r.includes("and verify edge cases")) &&
      tail.some((r) => r.includes("⎇ main")),
  },
  {
    name: "pi--v110-slash-palette.txt",

    description: "slash command palette open over composer",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("(1/")) && tail.some((r) => r.includes("⎇ main")),
  },
  {
    name: "pi--v110-working.txt",

    description: "composer with working spinner indicator",
    expectedTailAnchor: (_tail, all) => all.some((r) => r.includes("Working")),
  },
  {
    name: "pi--v110-narrow-idle.txt",

    description: "idle composer in narrow (~50 cols) terminal",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("⎇ main")),
  },
  {
    name: "pi--v110-core-selector.txt",

    description: "pi core selector modal (/model)",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel")),
  },

  // Standalone single-select dialogs (5)
  {
    name: "pi--v110-single.txt",
    description: "standalone single-select question dialog with numbered options",
    expectedTailAnchor: (tail) =>
      tail.some((r) => r.includes("↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel")),
  },
  {
    name: "pi--v110-single-desc.txt",
    description: "standalone single-select question dialog with option descriptions",
    expectedTailAnchor: (tail) =>
      tail.some((r) => r.includes("↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel")),
  },
  {
    name: "pi--v110-single-moved.txt",
    description: "single-select dialog with pointer moved to option 2",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel")) &&
      all.some((r) => r.includes("> 2. SQLite")),
  },
  {
    name: "pi--v110-single-editor-open.txt",
    description: "single-select dialog with free-answer editor open",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("Enter to submit • Esc to go back")),
  },
  {
    name: "pi--v110-single-narrow.txt",
    description: "single-select dialog in narrow (~50 cols) terminal",
    expectedTailAnchor: (tail) => tail.some((r) => r.includes("type a number or an answer • Esc to cancel")),
  },

  // Standalone multi-select dialogs (5)
  {
    name: "pi--v110-multi.txt",
    description: "standalone multi-select checkbox dialog",
    expectedTailAnchor: (tail) =>
      tail.some((r) => r.includes("↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel")),
  },
  {
    name: "pi--v110-multi-ticked.txt",

    description: "multi-select dialog with an option ticked",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel")) &&
      all.some((r) => r.includes("[x] 1. ESLint")),
  },
  {
    name: "pi--v110-multi-moved.txt",

    description: "multi-select dialog with ticked option and pointer moved to option 2",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel")) &&
      all.some((r) => r.includes("[x] 1. ESLint")) &&
      all.some((r) => r.includes("> [ ] 2. Prettier")),
  },
  {
    name: "pi--v110-multi-pointer-other.txt",

    description: "multi-select dialog with pointer on Type something.",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel")) &&
      all.some((r) => r.includes(">     5. Type something.")),
  },
  {
    name: "pi--v110-multi-editor-open.txt",

    description: "multi-select dialog with free-answer editor open on Type something.",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("Enter to submit • Esc to go back")) &&
      all.some((r) => r.includes("Type something. ✎")),
  },

  // Questionnaire tabs dialogs (7)
  {
    name: "pi--v110-tabs-single.txt",

    description: "questionnaire on single-choice tab with tab bar",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel")) &&
      all.some((r) => r.includes("←") && r.includes("Auth") && r.includes("Review")),
  },
  {
    name: "pi--v110-tabs-single-recorded.txt",

    description: "questionnaire on single-choice tab showing recorded answer checkmark",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel")) &&
      all.some((r) => r.includes("1. OAuth 2.0 / OIDC ✓")),
  },
  {
    name: "pi--v110-tabs-multi.txt",

    description: "questionnaire on multi-choice tab with checkboxes",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • ↑↓ navigate • Space tick • Enter confirm • type 1,3 • Esc cancel")) &&
      all.some((r) => r.includes("[ ] 1. Audit logs")),
  },
  {
    name: "pi--v110-tabs-compact.txt",

    description: "questionnaire with compact numeric tab bar (▢ 1 ▢ 2 ...)",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel")) &&
      all.some((r) => r.includes("▢  1") && r.includes("▢  2")),
  },
  {
    name: "pi--v110-tabs-editor-open.txt",

    description: "questionnaire tab page with free-answer editor open",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("Enter to submit • Esc to go back")) &&
      all.some((r) => r.includes("←") && r.includes("Review")),
  },
  {
    name: "pi--v110-review-incomplete.txt",

    description: "questionnaire Review tab with unanswered questions",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • Enter goes to the first unanswered • Esc cancel")) &&
      all.some((r) => r.includes("Review your answers")) &&
      all.some((r) => r.includes("Unanswered: Features, Deploy")),
  },
  {
    name: "pi--v110-review-complete.txt",

    description: "questionnaire Review tab with all questions answered",
    expectedTailAnchor: (tail, all) =>
      tail.some((r) => r.includes("←→ tabs • Enter submit • Esc cancel")) &&
      all.some((r) => r.includes("Review your answers")) &&
      all.some((r) => r.includes("✓ All answered — Enter to submit")),
  },
];

describe("pi 1.1.0 fixture corpus", () => {
  it("covers all 25 expected fixtures", () => {
    expect(EXPECTATIONS).toHaveLength(25);
  });

  describe.each(EXPECTATIONS)("$name ($description)", ({ name, expectedTailAnchor }) => {
    const fixturePath = join(PANES_DIR, name);

    it("exists on disk in web/src/fixtures/panes/", () => {
      expect(existsSync(fixturePath)).toBe(true);
    });

    it("is non-empty and contains byte-faithful ESC bytes", () => {
      const raw = readFileSync(fixturePath, "utf8");
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.includes("\x1b")).toBe(true);
    });

    it("parses through parseAnsi → splitLines pipeline", () => {
      const raw = readFileSync(fixturePath, "utf8");
      const styledLines = splitLines(parseAnsi(raw));
      expect(styledLines.length).toBeGreaterThan(0);

      const allRows = styledLines.map(lineText);
      const nonBlank = allRows.filter((r) => r.trim().length > 0);
      expect(nonBlank.length).toBeGreaterThan(0);

      const tailRows = nonBlank.slice(-8);
      const matched = expectedTailAnchor(tailRows, allRows);
      expect(matched, `Expected tail anchor predicate to match in tail rows:\n${tailRows.join("\n")}`).toBe(true);
    });
  });
});

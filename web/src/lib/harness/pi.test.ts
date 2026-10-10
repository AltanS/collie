import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { describeAdapterConformance } from "./conformance";
import {
  dialogAcceptsTyping,
  extractInputDraft,
  extractStatusLines,
  newlineSubmits,
  piAdapter,
  piBuildBlocks,
} from "./pi";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const allPiFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("pi--") && f.endsWith(".txt"))
  .toSorted();

const foreignFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt") && !f.startsWith("pi--"))
  .toSorted();

// The 14 pi question dialog captures that lift an interactive block:
// - 4 standalone single questions (prompt-select)
// - 5 multi-select questions (multi-select, standalone and questionnaire tab)
// - 3 questionnaire single question pages (wizard, phase: question)
// - 2 questionnaire review pages (wizard, phase: review)
const LIFTED = new Set([
  "pi--v110-single.txt",
  "pi--v110-single-desc.txt",
  "pi--v110-single-moved.txt",
  "pi--v110-single-narrow.txt",
  "pi--v110-multi.txt",
  "pi--v110-multi-ticked.txt",
  "pi--v110-multi-moved.txt",
  "pi--v110-multi-pointer-other.txt",
  "pi--v110-tabs-single.txt",
  "pi--v110-tabs-single-recorded.txt",
  "pi--v110-tabs-multi.txt",
  "pi--v110-tabs-compact.txt",
  "pi--v110-review-incomplete.txt",
  "pi--v110-review-complete.txt",
]);

const ownFixtures = allPiFixtures.filter((f) => LIFTED.has(f));
const neutralFixtures = allPiFixtures.filter((f) => !LIFTED.has(f));

// Captures where composerReady is true, but no expected_prompt region binds:
// - pi--v110-slash-palette.txt: slash palette pushes composer bottom rule beyond bridge 6-row window
// - pi--v110-*-editor-open.txt: answer editor content line is currently blank, so rstrip yields ""
// - all 12 question dialog pages: lifted dialog owns tail; no composer bottom rule exists
const UNBOUND_COMPOSER_FIXTURES = [
  "pi--v110-slash-palette.txt",
  "pi--v110-single-editor-open.txt",
  "pi--v110-multi-editor-open.txt",
  "pi--v110-tabs-editor-open.txt",
  "pi--v110-single.txt",
  "pi--v110-single-desc.txt",
  "pi--v110-single-moved.txt",
  "pi--v110-single-narrow.txt",
  "pi--v110-multi.txt",
  "pi--v110-multi-ticked.txt",
  "pi--v110-multi-moved.txt",
  "pi--v110-multi-pointer-other.txt",
  "pi--v110-tabs-single.txt",
  "pi--v110-tabs-single-recorded.txt",
  "pi--v110-tabs-multi.txt",
  "pi--v110-tabs-compact.txt",
];

describeAdapterConformance(piAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
  unboundComposerFixtures: UNBOUND_COMPOSER_FIXTURES,
});

describe("pi adapter — full corpus matrix", () => {
  interface CorpusMatrixRow {
    file: string;
    composerReady: boolean;
    draft: string | null;
    dialogAcceptsTyping: boolean;
    modalOnScreen: boolean;
    liftedKind: "prompt-select" | "wizard" | "multi-select" | null;
  }

  const MATRIX: CorpusMatrixRow[] = [
    // Composer states
    {
      file: "pi--v110-idle.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-idle-default-footer.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-draft.txt",
      composerReady: true,
      draft: "Add unit tests for the parser",
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-draft-multiline.txt",
      composerReady: true,
      draft: "Add unit tests for the parser and verify edge cases",
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-slash-palette.txt",
      composerReady: true,
      draft: "/",
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-working.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
    {
      file: "pi--v110-narrow-idle.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },

    // Single-choice question dialogs
    {
      file: "pi--v110-single.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "prompt-select",
    },
    {
      file: "pi--v110-single-desc.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "prompt-select",
    },
    {
      file: "pi--v110-single-moved.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "prompt-select",
    },
    {
      file: "pi--v110-single-narrow.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "prompt-select",
    },
    {
      file: "pi--v110-single-editor-open.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: null,
    },

    // Multi-select question dialogs
    {
      file: "pi--v110-multi.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "multi-select",
    },
    {
      file: "pi--v110-multi-ticked.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "multi-select",
    },
    {
      file: "pi--v110-multi-moved.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "multi-select",
    },
    {
      file: "pi--v110-multi-pointer-other.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "multi-select",
    },
    {
      file: "pi--v110-multi-editor-open.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: null,
    },

    // Questionnaire tabs & Review
    {
      file: "pi--v110-tabs-single.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "wizard",
    },
    {
      file: "pi--v110-tabs-single-recorded.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "wizard",
    },
    {
      file: "pi--v110-tabs-multi.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "multi-select",
    },
    {
      file: "pi--v110-tabs-compact.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: true,
      modalOnScreen: true,
      liftedKind: "wizard",
    },
    {
      file: "pi--v110-tabs-editor-open.txt",
      composerReady: true,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: null,
    },
    {
      file: "pi--v110-review-incomplete.txt",
      composerReady: false,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "wizard",
    },
    {
      file: "pi--v110-review-complete.txt",
      composerReady: false,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: "wizard",
    },

    // Core selector modal & legacy editor
    {
      file: "pi--v110-core-selector.txt",
      composerReady: false,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: true,
      liftedKind: null,
    },
    {
      file: "pi--v085-working-editor.txt",
      composerReady: false,
      draft: null,
      dialogAcceptsTyping: false,
      modalOnScreen: false,
      liftedKind: null,
    },
  ];

  for (const row of MATRIX) {
    it(`${row.file}: matches matrix expectations`, () => {
      const lines = loadLines(row.file);
      expect(piAdapter.composerReady!(lines), "composerReady").toBe(row.composerReady);
      expect(extractInputDraft(lines), "draft").toBe(row.draft);
      expect(dialogAcceptsTyping(lines), "dialogAcceptsTyping").toBe(row.dialogAcceptsTyping);
      expect(piAdapter.modalOnScreen!(lines), "modalOnScreen").toBe(row.modalOnScreen);

      const blocks = piBuildBlocks(lines);
      const interactive = blocks.filter((b) => b.kind !== "raw");
      if (row.liftedKind === null) {
        expect(interactive, "expected raw only").toEqual([]);
      } else {
        expect(interactive.length, "expected 1 interactive block").toBe(1);
        expect(interactive[0]!.kind).toBe(row.liftedKind);
      }
    });
  }
});

describe("pi adapter — dialog typing", () => {
  it("dialogAcceptsTyping answers true on single-choice question pages and false on multi-select, Review, and modals", () => {
    expect(dialogAcceptsTyping(loadLines("pi--v110-single.txt"))).toBe(true);
    expect(dialogAcceptsTyping(loadLines("pi--v110-tabs-single.txt"))).toBe(true);
    expect(dialogAcceptsTyping(loadLines("pi--v110-multi.txt"))).toBe(false);
    expect(dialogAcceptsTyping(loadLines("pi--v110-tabs-multi.txt"))).toBe(false);
    expect(dialogAcceptsTyping(loadLines("pi--v110-review-incomplete.txt"))).toBe(false);
    expect(dialogAcceptsTyping(loadLines("pi--v110-review-complete.txt"))).toBe(false);
    expect(dialogAcceptsTyping(loadLines("pi--v110-core-selector.txt"))).toBe(false);
  });
});

describe("pi adapter — newlineSubmits", () => {
  it("newlineSubmits is true on active dialog pages and answer editor (where Enter commits/selects)", () => {
    expect(newlineSubmits(loadLines("pi--v110-single-editor-open.txt"))).toBe(true);
    expect(newlineSubmits(loadLines("pi--v110-multi-editor-open.txt"))).toBe(true);
    expect(newlineSubmits(loadLines("pi--v110-tabs-editor-open.txt"))).toBe(true);
    expect(newlineSubmits(loadLines("pi--v110-single.txt"))).toBe(true);
    expect(newlineSubmits(loadLines("pi--v110-multi.txt"))).toBe(true);
    expect(newlineSubmits(loadLines("pi--v110-tabs-single.txt"))).toBe(true);
  });

  it("newlineSubmits is false on normal composer (where Enter inserts raw newline)", () => {
    expect(newlineSubmits(loadLines("pi--v110-idle.txt"))).toBe(false);
    expect(newlineSubmits(loadLines("pi--v110-draft.txt"))).toBe(false);
    expect(newlineSubmits(loadLines("pi--v110-review-complete.txt"))).toBe(false);
  });
});

describe("pi adapter — status lines & declarations", () => {
  it("declares cancelKey as Escape with positive modalOnScreen evidence", () => {
    expect(piAdapter.cancelKey).toBe("Escape");
    expect(piAdapter.modalOnScreen).toBeTypeOf("function");
  });

  it("extracts styled status lines from composer footer and returns empty when no composer", () => {
    const idleStatus = extractStatusLines(loadLines("pi--v110-idle.txt"));
    expect(idleStatus.length).toBeGreaterThan(0);

    const defaultFooterStatus = extractStatusLines(loadLines("pi--v110-idle-default-footer.txt"));
    expect(defaultFooterStatus.length).toBe(2);

    // Slash palette has the footer below it
    const slashStatus = extractStatusLines(loadLines("pi--v110-slash-palette.txt"));
    expect(slashStatus.length).toBe(1);

    // Dialogs have no composer statuslines
    expect(extractStatusLines(loadLines("pi--v110-single.txt"))).toEqual([]);
    expect(extractStatusLines(loadLines("pi--v110-core-selector.txt"))).toEqual([]);
  });
});

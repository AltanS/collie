import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyExpectedPrompt } from "../../../../../bridge/prompt-binding";
import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import {
  multiSelectEquals,
  multiSelectIdentity,
  type MultiSelectModel,
} from "../multi-select-model";
import { detectMultiSelect, detectMultiSelectRegion } from "./multi";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function loadFixture(name: string) {
  const content = readFileSync(join(PANES_DIR, name), "utf8");
  return { content, lines: splitLines(parseAnsi(content)) };
}

function loadLines(name: string): StyledLine[] {
  return loadFixture(name).lines;
}

function expectCheckbox(model: MultiSelectModel | null): Extract<MultiSelectModel, { phase: "checkbox" }> {
  expect(model).not.toBeNull();
  if (!model || model.phase !== "checkbox") throw new Error("expected checkbox phase");
  return model;
}

const COMPOSER_FIXTURES = [
  "pi--v110-idle.txt",
  "pi--v110-idle-default-footer.txt",
  "pi--v110-draft.txt",
  "pi--v110-draft-multiline.txt",
  "pi--v110-narrow-idle.txt",
  "pi--v110-slash-palette.txt",
  "pi--v110-working.txt",
];

const SINGLE_SELECT_FIXTURES = [
  "pi--v110-single.txt",
  "pi--v110-single-desc.txt",
  "pi--v110-single-moved.txt",
  "pi--v110-single-narrow.txt",
  "pi--v110-tabs-single.txt",
  "pi--v110-tabs-single-recorded.txt",
];

const REVIEW_FIXTURES = [
  "pi--v110-review-complete.txt",
  "pi--v110-review-incomplete.txt",
];

const EDITOR_OPEN_FIXTURES = [
  "pi--v110-multi-editor-open.txt",
  "pi--v110-tabs-editor-open.txt",
  "pi--v110-single-editor-open.txt",
];

// Helper to create synthetic styled lines from plain string representation
function makeSyntheticPane(opts: {
  options: string[];
  pointerLine?: number; // 0-based index among options
  question?: string;
  extraFooterLines?: string[];
}): StyledLine[] {
  const ACCENT_RULE = "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m";
  const FOOTER = "↑↓ navigate • Space to tick • Enter to confirm • Esc to cancel";
  const texts: string[] = [
    ACCENT_RULE,
    opts.question ?? "Pick options:",
    "",
    ...opts.options.map((opt, i) => {
      const ptr = opts.pointerLine === i ? "> " : "  ";
      return `${ptr}${opt}`;
    }),
    "",
    FOOTER,
    ACCENT_RULE,
    ...(opts.extraFooterLines ?? ["⎇ main unknown │ unknown"]),
  ];
  return splitLines(parseAnsi(texts.join("\n")));
}

// ---------------------------------------------------------------------------------------------
// 1. Detection across the corpus
// ---------------------------------------------------------------------------------------------

describe("detectMultiSelect — corpus detection", () => {
  it("detects standalone multi-select (pi--v110-multi.txt)", () => {
    const lines = loadLines("pi--v110-multi.txt");
    const region = detectMultiSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(0);

    const m = expectCheckbox(region!.model);
    expect(m.phase).toBe("checkbox");
    expect(m.question).toBe("Select code quality tools to enable: Pick one or more options.");
    expect(m.steps).toBeNull();
    expect(m.escape).toBeNull();
    expect(m.toggle).toBe("walkSpace");
    expect(m.advanceKeys).toEqual(["Enter"]);
    expect(m.advanceLabel).toBe("Confirm");
    expect(m.advanceNeedsChecked).toBe(true);

    // Pointer on row 1
    expect(m.pointer).toBe("option");
    expect(m.pointerRow).toBe(1);

    // 4 checkable options ("Type something." is not an option)
    expect(m.options).toHaveLength(4);
    expect(m.options[0]).toEqual({
      n: 1,
      label: "ESLint",
      description: "Pluggable JavaScript linter",
      checked: false,
    });
    expect(m.options[1]).toEqual({
      n: 2,
      label: "Prettier",
      description: "Opinionated code formatter",
      checked: false,
    });
    expect(m.options[2]).toEqual({
      n: 3,
      label: "Vitest",
      description: "Vite-native unit test framework",
      checked: false,
    });
    expect(m.options[3]).toEqual({
      n: 4,
      label: "Tailwind CSS",
      description: "Utility-first CSS framework",
      checked: false,
    });
  });

  it("detects multi-select with ticked option (pi--v110-multi-ticked.txt)", () => {
    const lines = loadLines("pi--v110-multi-ticked.txt");
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.pointer).toBe("option");
    expect(m.pointerRow).toBe(1);
    expect(m.options[0]!.checked).toBe(true);
    expect(m.options[1]!.checked).toBe(false);
  });

  it("detects multi-select with moved pointer (pi--v110-multi-moved.txt)", () => {
    const lines = loadLines("pi--v110-multi-moved.txt");
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.pointer).toBe("option");
    expect(m.pointerRow).toBe(2);
    expect(m.options[0]!.checked).toBe(true);
    expect(m.options[1]!.checked).toBe(false);
  });

  it("detects multi-select with pointer on 'Type something.' (pi--v110-multi-pointer-other.txt)", () => {
    const lines = loadLines("pi--v110-multi-pointer-other.txt");
    const m = expectCheckbox(detectMultiSelect(lines));
    // The pointer on 'Type something.' reports 'other' on row 5, which refuses the advance but allows walking back.
    expect(m.pointer).toBe("other");
    expect(m.pointerRow).toBe(5);
    expect(m.options[0]!.checked).toBe(true);
    expect(m.options[1]!.checked).toBe(false);
  });

  it("detects questionnaire multi-select page (pi--v110-tabs-multi.txt)", () => {
    const lines = loadLines("pi--v110-tabs-multi.txt");
    const region = detectMultiSelectRegion(lines);
    expect(region).not.toBeNull();

    const m = expectCheckbox(region!.model);
    expect(m.phase).toBe("checkbox");
    expect(m.question).toBe("Select additional features to enable: Pick one or more options.");
    expect(m.toggle).toBe("walkSpace");
    expect(m.advanceKeys).toEqual(["Enter"]);
    expect(m.advanceLabel).toBe("Confirm");
    expect(m.advanceNeedsChecked).toBe(true);
    expect(m.pointer).toBe("option");
    expect(m.pointerRow).toBe(1);

    // Wizard stepper chips from tab bar
    expect(m.steps).toEqual([
      { label: "Auth", answered: true, current: false },
      { label: "Features", answered: false, current: true },
      { label: "Deploy", answered: false, current: false },
    ]);

    expect(m.options).toHaveLength(3);
    expect(m.options[0]).toEqual({ n: 1, label: "Audit logs", checked: false });
    expect(m.options[1]).toEqual({ n: 2, label: "Rate limiting", checked: false });
    expect(m.options[2]).toEqual({ n: 3, label: "Webhooks", checked: false });
  });

  it.each([
    "pi--v110-multi.txt",
    "pi--v110-multi-ticked.txt",
    "pi--v110-multi-moved.txt",
    "pi--v110-multi-pointer-other.txt",
    "pi--v110-tabs-multi.txt",
  ])("regionSignature binds via verifyExpectedPrompt for %s", (name) => {
    const { content, lines } = loadFixture(name);
    const m = detectMultiSelect(lines)!;
    expect(m).not.toBeNull();
    const result = verifyExpectedPrompt(content, m.regionSignature);
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Identity & Equality Matrix (multi / multi-ticked / multi-moved / multi-pointer-other)
// ---------------------------------------------------------------------------------------------

describe("multiSelectEquals and multiSelectIdentity across pointer and checkbox states", () => {
  const multiUnticked = detectMultiSelect(loadLines("pi--v110-multi.txt"))!;
  const multiTicked = detectMultiSelect(loadLines("pi--v110-multi-ticked.txt"))!;
  const multiMoved = detectMultiSelect(loadLines("pi--v110-multi-moved.txt"))!;
  const multiPointerOther = detectMultiSelect(loadLines("pi--v110-multi-pointer-other.txt"))!;

  it("normalised signature is byte-identical across multi, ticked, moved, and pointer-other", () => {
    expect(multiUnticked.signature).toBe(multiTicked.signature);
    expect(multiTicked.signature).toBe(multiMoved.signature);
    expect(multiMoved.signature).toBe(multiPointerOther.signature);
  });

  it("multiSelectEquals holds between ticked, moved, and pointer-other (pointer moves do not break equality)", () => {
    expect(multiSelectEquals(multiTicked, multiMoved)).toBe(true);
    expect(multiSelectEquals(multiTicked, multiPointerOther)).toBe(true);
    expect(multiSelectEquals(multiMoved, multiPointerOther)).toBe(true);
  });

  it("multiSelectIdentity holds between ticked, moved, and pointer-other (pointer moves do not break identity)", () => {
    expect(multiSelectIdentity(multiTicked, multiMoved)).toBe(true);
    expect(multiSelectIdentity(multiTicked, multiPointerOther)).toBe(true);
    expect(multiSelectIdentity(multiMoved, multiPointerOther)).toBe(true);
  });

  it("multiSelectEquals and multiSelectIdentity fail between unticked and ticked (checkbox flip breaks them)", () => {
    // When a box flips underfoot, equality and identity break so macro stops rather than shipping drifted state
    expect(multiSelectEquals(multiUnticked, multiTicked)).toBe(false);
    expect(multiSelectIdentity(multiUnticked, multiTicked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Refusals
// ---------------------------------------------------------------------------------------------

describe("detectMultiSelect — refusals", () => {
  it.each(EDITOR_OPEN_FIXTURES)("refuses editor open on %s", (name) => {
    const lines = loadLines(name);
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it.each(SINGLE_SELECT_FIXTURES)("refuses single-select dialogs on %s", (name) => {
    const lines = loadLines(name);
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it.each(REVIEW_FIXTURES)("refuses questionnaire review screens on %s", (name) => {
    const lines = loadLines(name);
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it.each(COMPOSER_FIXTURES)("refuses composer fixtures on %s", (name) => {
    const lines = loadLines(name);
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("refuses pi core selector modal (pi--v110-core-selector.txt)", () => {
    const lines = loadLines("pi--v110-core-selector.txt");
    expect(detectMultiSelect(lines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Edge cases & Synthetic mutations
// ---------------------------------------------------------------------------------------------

describe("detectMultiSelect — mutations and boundaries", () => {
  it("accepts exactly 9 options", () => {
    const opts = Array.from({ length: 9 }, (_, i) => `[ ] ${i + 1}. Option ${i + 1}`);
    const lines = makeSyntheticPane({ options: opts, pointerLine: 0 });
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.options).toHaveLength(9);
    expect(m.pointerRow).toBe(1);
  });

  it("refuses >9 options (10 options)", () => {
    const opts = Array.from({ length: 10 }, (_, i) => `[ ] ${i + 1}. Option ${i + 1}`);
    const lines = makeSyntheticPane({ options: opts, pointerLine: 0 });
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("refuses 0 options", () => {
    const lines = makeSyntheticPane({ options: [] });
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("refuses non-consecutive numbering (1, 3)", () => {
    const lines = makeSyntheticPane({
      options: ["[ ] 1. First", "[ ] 3. Third"],
      pointerLine: 0,
    });
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("refuses multiple pointer glyphs", () => {
    const lines = splitLines(
      parseAnsi(
        "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "Choose:\n\n" +
          "> [ ] 1. One\n" +
          "> [ ] 2. Two\n\n" +
          "↑↓ navigate • Space to tick • Enter to confirm • Esc to cancel\n" +
          "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "⎇ main unknown",
      ),
    );
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("reports null pointer and pointerRow when no pointer is visible", () => {
    const lines = makeSyntheticPane({
      options: ["[ ] 1. First", "[ ] 2. Second"],
      pointerLine: -1, // no pointer
    });
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.pointer).toBeNull();
    expect(m.pointerRow).toBeNull();
  });

  it("reports other pointer when pointer is on an unrecognized non-option row", () => {
    const lines = splitLines(
      parseAnsi(
        "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "Choose:\n\n" +
          "  [ ] 1. One\n" +
          ">      5. Type something.\n\n" +
          "↑↓ navigate • Space to tick • Enter to confirm • Esc to cancel\n" +
          "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "⎇ main unknown",
      ),
    );
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.pointer).toBe("other");
    expect(m.pointerRow).toBe(2);
  });

  it("refuses scrolled-up dialogs (more than 2 status rows below bottom rule)", () => {
    const lines = makeSyntheticPane({
      options: ["[ ] 1. One"],
      pointerLine: 0,
      extraFooterLines: ["transcript 1", "transcript 2", "transcript 3"],
    });
    expect(detectMultiSelect(lines)).toBeNull();
  });

  it("accepts 'Space to toggle' hint variant (rpiv-ask-user-question parity)", () => {
    const lines = splitLines(
      parseAnsi(
        "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "Choose features:\n\n" +
          "> [ ] 1. Auth\n" +
          "  [ ] 2. Database\n\n" +
          "↑/↓ to navigate · Space to toggle · Tab to switch questions · Esc to cancel\n" +
          "\x1b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\x1b[0m\n" +
          "⎇ main unknown",
      ),
    );
    const m = expectCheckbox(detectMultiSelect(lines));
    expect(m.options).toHaveLength(2);
    expect(m.options[0]!.label).toBe("Auth");
  });
});

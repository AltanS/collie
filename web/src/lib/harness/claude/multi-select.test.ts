import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectMultiSelect, detectMultiSelectRegion } from "./multi-select";
import { detectWizard } from "./wizard";
import { detectPromptSelect } from "./prompt-select";
import { detectPreviewSelect } from "./preview-select";
import { lineText } from "./markers";

// The multi-select detector is developed and gated against byte-faithful sandbox captures of a real
// multiSelect AskUserQuestion (claude--select-multiselect-*.txt; interaction model probed live).
// Each fixture runs through the production parseAnsi → splitLines pipeline. Hard gates: the checkbox
// screen detects its question / options / checked state / escape / pointer; the review screen detects
// its incomplete flag; every OTHER grammar (prompt-select / wizard / preview) yields zero detections.

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite rewrites).
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
const fixtureLines = (name: string): StyledLine[] => splitLines(parseAnsi(fixtureText(name)));

describe("detectMultiSelect — checkbox phase", () => {
  it("all unchecked: question, options (labels + n + unchecked), escape, pointer", () => {
    const model = detectMultiSelect(fixtureLines("claude--select-multiselect-single.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "checkbox") throw new Error("expected checkbox phase");
    expect(model!.question).toBe("Which pizza toppings do you want?");
    // "5. [ ] Type something" is a free-text row → stays with the composer, dropped from options.
    expect(model!.options.map((o) => o.label)).toEqual(["Cheese", "Mushrooms", "Olives", "Peppers"]);
    // The digit that toggles each row.
    expect(model!.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    // Descriptions attach like the sibling grammars.
    expect(model!.options[0]!.description).toBe("Classic melted cheese topping.");
    // Nothing checked yet.
    expect(model!.options.every((o) => !o.checked)).toBe(true);
    // "6. Chat about this" is the escape (aborts the tool), kept out of options.
    expect(model!.escape).toEqual({ n: 6, label: "Chat about this" });
    // The ❯ sits on the first option row.
    expect(model!.pointer).toBe("option");
  });

  it("some checked: the [✔] rows lift into checked=true (byte-faithful fixture)", () => {
    const model = detectMultiSelect(fixtureLines("claude--select-multiselect-checked.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "checkbox") throw new Error("expected checkbox phase");
    // Mushrooms + Olives were hand-checked; Cheese + Peppers stay unchecked.
    expect(model!.options.map((o) => [o.label, o.checked])).toEqual([
      ["Cheese", false],
      ["Mushrooms", true],
      ["Olives", true],
      ["Peppers", false],
    ]);
  });

  it("the checked screen's core signature is checkbox-independent (== the all-unchecked screen's)", () => {
    // The pointer + option checkboxes + stepper answered-glyph are normalised out, so the two screens
    // — same dialog, different checked state — share ONE identity signature (the drift key). The
    // per-option `checked` is what still separates them (see multiSelectEquals).
    const a = detectMultiSelect(fixtureLines("claude--select-multiselect-single.txt"))!;
    const b = detectMultiSelect(fixtureLines("claude--select-multiselect-checked.txt"))!;
    expect(a.signature).toBe(b.signature);
  });
});

describe("detectMultiSelect — review phase", () => {
  it("detects the confirm screen and the incomplete (⚠) flag", () => {
    const model = detectMultiSelect(fixtureLines("claude--select-multiselect-review.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.incomplete).toBe(true);
  });

  it("a complete review (no ⚠) is incomplete=false", () => {
    const buf = [
      "←  ☒ Toppings  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ].join("\n");
    const model = detectMultiSelect(splitLines(parseAnsi(buf)));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.incomplete).toBe(false);
  });
});

describe("detectMultiSelectRegion — render boundary", () => {
  it("starts the checkbox region at the single-question stepper (raw scrollback stays above)", () => {
    const lines = fixtureLines("claude--select-multiselect-single.txt");
    const region = detectMultiSelectRegion(lines);
    expect(region).not.toBeNull();
    const first = lineText(lines[region!.startLine]!);
    expect(first).toContain("Toppings");
    expect(first).toContain("Submit");
    expect(region!.model).toEqual(detectMultiSelect(lines));
  });

  it("starts the review region at the stepper too", () => {
    const lines = fixtureLines("claude--select-multiselect-review.txt");
    const region = detectMultiSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(lineText(lines[region!.startLine]!)).toContain("Submit");
  });
});

describe("detectMultiSelect — false-positive gate", () => {
  // The other grammars must never claim a multiSelect fixture (each of the three phases).
  for (const name of [
    "claude--select-multiselect-single.txt",
    "claude--select-multiselect-checked.txt",
    "claude--select-multiselect-review.txt",
  ]) {
    it(`${name} is not a prompt-select / wizard / preview dialog`, () => {
      const lines = fixtureLines(name);
      expect(detectPromptSelect(lines), "prompt-select").toBeNull();
      expect(detectWizard(lines), "wizard").toBeNull();
      expect(detectPreviewSelect(lines), "preview").toBeNull();
    });
  }

  // Conversely, multi-select must never claim a NON-multiSelect dialog.
  for (const name of [
    "claude--select-menu.txt",
    "claude--wizard-q1.txt",
    "claude--wizard-submit.txt",
    "claude--permission-edit.txt",
    "claude--trust-prompt.txt",
    "claude--working.txt",
    "claude--fresh-idle.txt",
  ]) {
    it(`${name} produces zero multi-select detections`, () => {
      expect(detectMultiSelect(fixtureLines(name))).toBeNull();
    });
  }

  it("a checkbox screen scrolled up out of the tail does not match (output appended below)", () => {
    const withTail =
      fixtureText("claude--select-multiselect-single.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectMultiSelect(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("empty and whitespace-only buffers do not match", () => {
    expect(detectMultiSelect(splitLines(parseAnsi("")))).toBeNull();
    expect(detectMultiSelect(splitLines(parseAnsi("\n\n   \n")))).toBeNull();
  });

  it("bails when the checkbox screen has no navigable Submit row (partial render → fail closed)", () => {
    // A well-formed checkbox screen MINUS the standalone "Submit" row: the Submit macro would have no
    // verified target to walk onto, so the detector must not lift it (falls to the raw mirror instead).
    const buf = [
      "←  ☐ Toppings  ✔ Submit  →",
      "",
      "Which pizza toppings do you want?",
      "",
      "❯ 1. [ ] Cheese",
      "  2. [ ] Mushrooms",
      "  3. [ ] Olives",
      "  4. [ ] Peppers",
      "  5. [ ] Type something",
      "─".repeat(80),
      "  6. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(detectMultiSelect(splitLines(parseAnsi(buf)))).toBeNull();
  });

  it("bails when the checkbox menu exceeds 9 rows (a row ≥10 needs the unsendable digit \"10\")", () => {
    // Ten checkbox options + the "Chat about this" escape = an 11-row menu. Option 10's toggle would
    // need the two-key "10", which pane.send_keys can't express — so the detector fails closed to the
    // raw mirror + keys pad rather than render a control it can't actuate.
    const optRows = Array.from({ length: 10 }, (_, i) => `  ${i + 1}. [ ] Option ${i + 1}`);
    const buf = [
      "←  ☐ Pick  ✔ Submit  →",
      "",
      "Choose as many as you like",
      "",
      ...optRows,
      "     Submit",
      "─".repeat(80),
      "  11. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(detectMultiSelect(splitLines(parseAnsi(buf)))).toBeNull();
  });
});

describe("wizard bails on a multiSelect step inside a multi-question wizard (v1 unsupported)", () => {
  // A ≥3-chip stepper (2 questions + Submit) whose option rows carry the checkbox prefix: a
  // multiSelect step of a multi-question wizard. The wizard grammar must bail (a digit there TOGGLES,
  // not select-and-advance), and multi-select — which needs EXACTLY a single-question stepper — bails
  // too, so it falls to the raw mirror + keys pad.
  const checkboxWizard = [
    "←  ☐ Focus  ☐ Scope  ✔ Submit  →",
    "",
    "Which options should we use?",
    "",
    "  1. [ ] Alpha",
    "  2. [✔] Beta",
    "Enter to select · Esc to cancel",
  ].join("\n");
  const plainWizard = checkboxWizard.replace("[ ] Alpha", "Alpha").replace("[✔] Beta", "Beta");

  it("the plain (no-checkbox) control DOES detect as a wizard", () => {
    expect(detectWizard(splitLines(parseAnsi(plainWizard)))).not.toBeNull();
  });

  it("the checkbox variant makes the wizard bail — and multi-select doesn't claim it either", () => {
    const lines = splitLines(parseAnsi(checkboxWizard));
    expect(detectWizard(lines)).toBeNull();
    expect(detectMultiSelect(lines)).toBeNull();
  });
});

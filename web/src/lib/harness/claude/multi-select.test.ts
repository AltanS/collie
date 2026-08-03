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

describe("detectMultiSelect region signature", () => {
  it("is literal contiguous fixture text in both phases", () => {
    for (const name of [
      "claude--select-multiselect-single.txt",
      "claude--select-multiselect-checked.txt",
      "claude--select-multiselect-review.txt",
    ]) {
      const lines = fixtureLines(name);
      const screenText = lines.map(lineText).join("\n");
      const model = detectMultiSelect(lines);
      expect(model).not.toBeNull();
      expect(screenText.includes(model!.regionSignature)).toBe(true);
    }
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

// A multiSelect question can also be ONE STEP of a multi-question wizard. That shape differs from the
// standalone dialog in two ways the grammar has to know about: the stepper carries N question chips
// instead of one, and the navigable row reads "Next" until the last question, where it reads
// "Submit". Fixtures are sandbox captures of a real two-question dialog driven end to end.
describe("detectMultiSelect — a checkbox question inside a wizard", () => {
  const checkbox = (name: string) => {
    const m = detectMultiSelect(fixtureLines(name));
    expect(m).not.toBeNull();
    if (m!.phase !== "checkbox") throw new Error("expected checkbox phase");
    return m!;
  };

  it("lifts a non-final step, with the wizard's chips and a Next advance row", () => {
    const m = checkbox("claude--wizard-multiselect-q1.txt");
    expect(m.steps).toEqual([
      { label: "Toppings", answered: false, current: true },
      { label: "Crust", answered: false, current: false },
    ]);
    expect(m.advanceLabel).toBe("Next");
    expect(m.question).toBe("Which toppings would you like on your pizza?");
    expect(m.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    expect(m.options.map((o) => o.label)).toEqual([
      "Pepperoni",
      "Mushrooms",
      "Bell peppers",
      "Extra cheese",
    ]);
    expect(m.options.every((o) => !o.checked)).toBe(true);
    // The free-text "Type something" row stays with the composer; "Chat about this" is the escape.
    expect(m.escape?.label).toMatch(/chat about this/i);
    expect(m.options[0]!.description).toMatch(/crisp at the edges/);
  });

  it("reads the ticked boxes, and the chip answered once ANY box is ticked", () => {
    const m = checkbox("claude--wizard-multiselect-checked.txt");
    expect(m.options.map((o) => o.checked)).toEqual([true, false, true, false]);
    // "Answered" means touched, not complete — two of four boxes is enough to flip ☐ → ☒.
    expect(m.steps![0]).toEqual({ label: "Toppings", answered: true, current: true });
  });

  it("recognises the pointer sitting on the advance row", () => {
    // This is the state the closed-loop macro walks to and verifies before it ever presses Enter.
    const m = checkbox("claude--wizard-multiselect-pointer-next.txt");
    expect(m.pointer).toBe("advance");
  });

  it("reads Submit on the LAST step, not Next", () => {
    const m = checkbox("claude--wizard-multiselect-final.txt");
    expect(m.advanceLabel).toBe("Submit");
    expect(m.steps).toEqual([
      { label: "Size", answered: true, current: false },
      { label: "Extras", answered: false, current: true },
    ]);
    expect(m.question).toBe("Which extras should we add on the side?");
  });

  it("leaves the standalone single-question dialog with no steps", () => {
    // The generalisation must not turn every multiSelect into a wizard: with one question there is
    // nowhere to navigate, so the block renders no stepper.
    const m = checkbox("claude--select-multiselect-single.txt");
    expect(m.steps).toBeNull();
    expect(m.advanceLabel).toBe("Submit");
  });

  it("does not claim the wizard's own review screen", () => {
    // A multi-question dialog reviews ONCE at the end, and that screen belongs to the wizard grammar.
    // Two grammars claiming one screen is how a tap comes to mean two different things.
    const lines = fixtureLines("claude--wizard-submit.txt");
    expect(detectMultiSelect(lines)).toBeNull();
    expect(detectWizard(lines)).not.toBeNull();
  });
});

// Pane text is model-authored and untrusted, so the advance row is located by POSITION — last
// non-blank line above the rule that separates the menu from the escape row — never by scanning for
// the first line that happens to read "Submit"/"Next". These three cases are what text-matching cost.
describe("detectMultiSelect — the advance row is a place, not a word", () => {
  function pane(rows: string[], advance: string | null): string {
    return [
      "←  ☐ Toppings  ✔ Submit  →",
      "",
      "Which toppings would you like?",
      "",
      ...rows,
      ...(advance === null ? [] : [`     ${advance}`]),
      "─".repeat(60),
      // The escape continues the menu's 1..m numbering — trailingMenuRows requires the run.
      `  ${rows.filter((r) => /^\s*❯?\s*\d+\./.test(r)).length + 1}. Chat about this`,
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
  }
  const model = (s: string) => detectMultiSelect(splitLines(parseAnsi(s)));

  it("a description reading 'Next' does not rename the button", () => {
    // Otherwise the control advertises an action it does not perform: it would say "Next" while the
    // tap walks onto the real Submit and ends the whole dialog.
    const m = model(pane(["❯ 1. [ ] Garlic knots", "  Next", "  2. [ ] Caesar salad"], "Submit"));
    expect(m).not.toBeNull();
    if (m!.phase !== "checkbox") throw new Error("expected checkbox phase");
    expect(m!.advanceLabel).toBe("Submit");
    // …and the decoy stays visible as the description it actually is.
    expect(m!.options[0]!.description).toBe("Next");
  });

  it("bails when there is no advance row, however much the text looks like one", () => {
    // The fail-closed guard exists for the garbled render. A description satisfying it would leave
    // the macro spraying Down keys into a live pane, hunting a row that isn't there.
    expect(model(pane(["❯ 1. [ ] Garlic knots", "  Submit", "  2. [ ] Caesar salad"], null))).toBeNull();
  });

  it("a decoy '❯ Submit' line does not forge the pointer", () => {
    // pointerAt returns on the FIRST ❯ it sees. If a decoy above the real pointer could claim
    // "advance", the macro would press Enter on whatever row the terminal's ❯ is really on — and on
    // "Chat about this" that aborts the entire tool call.
    const m = model(pane(["  1. [ ] Garlic knots", "  ❯ Submit", "❯ 2. [ ] Caesar salad"], "Submit"));
    expect(m).not.toBeNull();
    if (m!.phase !== "checkbox") throw new Error("expected checkbox phase");
    // A decoy still shadows the real ❯ (pointerAt takes the first one), so this reads "other" rather
    // than "option" — which is fine: every non-"advance" pointer costs the macro a Down, never an
    // Enter. What must never happen is "advance".
    expect(m!.pointer).not.toBe("advance");
  });
});

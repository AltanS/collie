import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectWizard, detectWizardRegion } from "./wizard";
import { detectPromptSelect } from "./prompt-select";
import { lineText } from "./markers";

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite statically
// rewrites into a root-relative asset path) so the fixtures resolve regardless of the run cwd.
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

// The wizard detector is developed and gated against the byte-faithful sandbox captures of a real
// multi-question AskUserQuestion flow (claude--wizard-*.txt; choreography in WIZARD_NOTES.md).
// Each fixture runs through the production parseAnsi → splitLines pipeline. Hard gates: every
// wizard state detects with the right phase / chips / options / keystroke plan; every NON-wizard
// fixture (single-question selects included) produces zero detections.

function fixtureText(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(fixtureText(name)));
}

describe("detectWizard — question phase", () => {
  it("fresh wizard (q1): all chips unanswered, first current, digit-alone keys", () => {
    const model = detectWizard(fixtureLines("claude--wizard-q1.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.steps).toEqual([
      { label: "Focus area", answered: false, current: true },
      { label: "Scope", answered: false, current: false },
      { label: "Workflow", answered: false, current: false },
    ]);
    expect(model!.question).toBe("Which focus area should we work on?");
    // "4. Type something." is a free-text row → stays with the composer, not a button.
    expect(model!.options.map((o) => o.label)).toEqual(["Parser", "UI", "Tests", "Chat about this"]);
    // Wizard digits fire ALONE (instant select + advance) — no trailing Enter.
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"], ["5"]]);
    expect(model!.options[0]!.description).toContain("parsing logic");
    // "Chat about this" aborts the whole wizard → flagged as the escape row.
    expect(model!.options.map((o) => o.escape)).toEqual([false, false, false, true]);
    expect(model!.options.every((o) => !o.chosen)).toBe(true);
  });

  it("mid-flight (q2): first chip answered, second current", () => {
    const model = detectWizard(fixtureLines("claude--wizard-q2.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.steps).toEqual([
      { label: "Focus area", answered: true, current: false },
      { label: "Scope", answered: false, current: true },
      { label: "Workflow", answered: false, current: false },
    ]);
    expect(model!.question).toBe("What scope should this work have?");
    expect(model!.options.map((o) => o.label)).toEqual([
      "Small",
      "Medium",
      "Large",
      "Chat about this",
    ]);
  });

  it("revisited answered question: the chosen row's ✔ is lifted into `chosen`", () => {
    const model = detectWizard(fixtureLines("claude--wizard-q1-revisit.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.steps[0]).toEqual({ label: "Focus area", answered: true, current: true });
    const ui = model!.options.find((o) => o.label === "UI");
    expect(ui).toBeDefined();
    expect(ui!.chosen).toBe(true);
    expect(ui!.label).toBe("UI"); // the trailing " ✔" is stripped from the label
    expect(model!.options.filter((o) => o.chosen)).toHaveLength(1);
  });

  it("T2's original multi-question capture (select-multi) now detects as a wizard", () => {
    const model = detectWizard(fixtureLines("claude--select-multi.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.steps.map((s) => s.label)).toEqual(["Focus area", "Scope", "Workflow"]);
    expect(model!.steps[0]!.answered).toBe(true);
    expect(model!.question).toBe("How should I approach the work?");
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"], ["5"]]);
  });
});

describe("detectWizard — review (Submit) phase", () => {
  it("all answered: answers echoed, complete, no chip current (highlight is on Submit)", () => {
    const model = detectWizard(fixtureLines("claude--wizard-submit.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.steps).toEqual([
      { label: "Focus area", answered: true, current: false },
      { label: "Scope", answered: true, current: false },
      { label: "Workflow", answered: true, current: false },
    ]);
    expect(model!.incomplete).toBe(false);
    expect(model!.answers).toEqual([
      { question: "Which focus area should we work on?", answer: "UI" },
      { question: "What scope should this work have?", answer: "Medium" },
      { question: "How should we approach the work?", answer: "Plan first" },
    ]);
  });

  it("unanswered questions: the ⚠ warning becomes `incomplete`, no answers listed", () => {
    const model = detectWizard(fixtureLines("claude--wizard-submit-unanswered.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.incomplete).toBe(true);
    expect(model!.answers).toEqual([]);
    expect(model!.steps.every((s) => !s.answered)).toBe(true);
  });
});

describe("detectWizard — ≥10 options bail (L4)", () => {
  // A synthetic wizard step with `n` numbered options under a valid stepper header + select footer.
  function wizardBuf(n: number): string {
    const rows = Array.from({ length: n }, (_, i) => `  ${i + 1}. Option ${i + 1}`);
    return [
      "←  ☐ Focus area  ☐ Scope  ✔ Submit  →",
      "",
      "Which option should we use?",
      "",
      ...rows,
      "Enter to select · Esc to cancel",
    ].join("\n");
  }

  it("detects a 9-option wizard step (control — the shape is otherwise valid)", () => {
    const model = detectWizard(splitLines(parseAnsi(wizardBuf(9))));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.options).toHaveLength(9);
  });

  it("bails on a 10-option wizard step (option 10 would need the unsendable digit '10')", () => {
    // The wizard sends the digit ALONE to select+advance; "10" is rejected and would mis-answer, so
    // the >9 guard bails to the raw mirror rather than render a broken button.
    expect(detectWizard(splitLines(parseAnsi(wizardBuf(10))))).toBeNull();
  });
});

describe("detectWizard — false-positive gate", () => {
  // Every non-wizard state in the corpus, including all the single-choice dialogs T2 owns: the
  // wizard detector must never claim them (no Submit chip / no stepper).
  for (const name of [
    "claude--working.txt",
    "claude--fresh-idle.txt",
    "claude--done.txt",
    "claude--trust-prompt.txt",
    "claude--select-menu.txt",
    "claude--permission-edit.txt",
    "claude--permission-bash.txt",
    "claude--plan-approval.txt",
  ]) {
    it(`${name} produces zero detections`, () => {
      expect(detectWizard(fixtureLines(name))).toBeNull();
    });
  }

  it("a wizard that is NOT at the tail does not match (question phase)", () => {
    const withTail = fixtureText("claude--wizard-q1.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectWizard(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("a review step that is NOT at the tail does not match", () => {
    const withTail = fixtureText("claude--wizard-submit.txt") + "\n● Wrote the file\n";
    expect(detectWizard(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("empty and whitespace-only buffers do not match", () => {
    expect(detectWizard(splitLines(parseAnsi("")))).toBeNull();
    expect(detectWizard(splitLines(parseAnsi("\n\n   \n")))).toBeNull();
  });
});

describe("wizard vs prompt-select — mutual exclusion (no T2 regression)", () => {
  it("prompt-select still bails on every wizard fixture (its safety net stays)", () => {
    for (const name of [
      "claude--wizard-q1.txt",
      "claude--wizard-q2.txt",
      "claude--wizard-q1-revisit.txt",
      "claude--wizard-submit.txt",
      "claude--wizard-submit-unanswered.txt",
      "claude--select-multi.txt",
    ]) {
      expect(detectPromptSelect(fixtureLines(name)), name).toBeNull();
    }
  });

  it("the single-question select still detects as prompt-select, never as a wizard", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    expect(detectWizard(lines)).toBeNull();
    expect(detectPromptSelect(lines)).not.toBeNull();
  });
});

describe("detectWizardRegion — render boundary", () => {
  it("starts the region at the stepper header (raw scrollback stays above)", () => {
    const lines = fixtureLines("claude--wizard-q1.txt");
    const region = detectWizardRegion(lines);
    expect(region).not.toBeNull();
    const first = lineText(lines[region!.startLine]!);
    expect(first).toContain("Focus area");
    expect(first).toContain("Submit");
    // The line above the stepper is the dialog's top rule — left in the raw mirror.
    expect(region!.model).toEqual(detectWizard(lines));
  });

  it("review region also starts at the stepper header", () => {
    const lines = fixtureLines("claude--wizard-submit.txt");
    const region = detectWizardRegion(lines);
    expect(region).not.toBeNull();
    expect(lineText(lines[region!.startLine]!)).toContain("Submit");
  });
});

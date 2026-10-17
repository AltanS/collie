import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { buildBlocks } from "..";
import { dropTaskChecklist } from "./task-checklist";
import { detectWizard, detectWizardRegion } from "./wizard";
import { detectPromptSelect } from "./prompt-select";
import { lineText } from "./markers";
import { detectQuestionTabs } from "../opencode/question-tabs";
import { wizardsEqual, wizardsSameIdentity } from "../wizard-model";

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
    // "4. Type something." is the answer field → modelled as `field`, never an option button.
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

  // Claude Code 2.1.302 bars an echoed question with its own `│` (`│ ● …`, `│   …` continuations);
  // the `→` answer row under it carries no bar.
  const BARRED_ANSWERS = [
    {
      question:
        "When a user opens the settings page with unsaved changes still pending from an earlier visit, perhaps because they " +
        "closed the tab mid-edit, lost their network connection, or the session expired while a form was half-filled, how " +
        "should the page treat those leftover edits so that nothing is silently lost and the user is never surprised by " +
        "values they did not knowingly choose?",
      answer: "Restore with banner",
    },
    { question: "How should changes be saved?", answer: "Save button" },
    { question: "Where should the reset-to-defaults control live?", answer: "Page footer" },
  ];

  it("a barred, wrapped question keeps its answer beside two bare ones", () => {
    const model = detectWizard(fixtureLines("claude--v2302-wizard-review-long-q--w140.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.incomplete).toBe(false);
    expect(model!.answers).toEqual(BARRED_ANSWERS);
  });

  it("every item barred: all three answers are listed", () => {
    const model = detectWizard(fixtureLines("claude--v2302-wizard-review-barred--w140.txt"));
    expect(model).not.toBeNull();
    if (model!.phase !== "review") throw new Error("expected review phase");
    expect(model!.answers).toEqual(BARRED_ANSWERS);
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

// Claude Code 2.1.302 at 54 columns: the question wraps to nine rows, so the stepper sits eleven rows
// above the first option (vanilla behaviour). The capture also runs a theme plugin whose two-column
// gutter beside the dialog makes each full-width rule wrap into a `──` stub (theme hardening).
describe("detectWizard — a long question at a narrow width (Claude Code 2.1.302)", () => {
  const FIXTURE = "claude--v2302-wizard-long-question--w54.txt";

  it("reaches the stepper above a nine-row question", () => {
    const model = detectWizard(dropTaskChecklist(fixtureLines(FIXTURE)));
    expect(model).not.toBeNull();
    if (model!.phase !== "question") throw new Error("expected question phase");
    expect(model!.steps).toEqual([
      { label: "Branch", answered: false, current: true },
      { label: "Ranger dies", answered: false, current: false },
    ]);
    expect(model!.question).toBe(
      "new floor (Nerf Goblin Encounter): the explorer suggests a feature branch " +
        "`feat/goblin-two-round-call-out`. Its evidence: the change bumps the rules version (32 to 33), " +
        "touches the engine and content, and needs tests edited red first. The engine change is small, " +
        "though: the call stands until the shot, a fresh call is drawn only when none stands, and the " +
        "Ranger goes from 4 to 2. Where should it land?",
    );
    expect(model!.options.map((o) => o.label)).toEqual(["Land on main (Recommended)", "Feature branch", "Chat about this"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["4"]]);
    expect(model!.options.map((o) => o.escape)).toEqual([false, false, true]);
    expect(model!.options[0]!.description).toBe(
      "One item, one commit on main, in this release like the rest. Worst case: if Mary changes the " +
        "rule again before the cut, a second rules bump (to 34) lands on main too.",
    );
    expect(model!.options[1]!.description).toBe(
      "Build it on feat/goblin-two-round-call-out with a draft PR, merged by /ship. Worst case: an " +
        "extra merge step, and it's held out of the release until the merge.",
    );
  });

  it("lifts as a wizard block through the adapter", () => {
    const kinds = buildBlocks(fixtureLines(FIXTURE), { agent: "claude" }).map((b) => b.kind);
    expect(kinds).toContain("wizard");
  });
});

// The step's `Type something.` field (ADR 0113, grammar/ASK_FIELD_NOTES.md § Wizard), over the 2.1.299
// captures of a three-question wizard: modelled as a field, never an option, in every state the
// answer recipe walks it through.
describe("detectWizard — the answer field", () => {
  const step = (name: string) => {
    const model = detectWizard(fixtureLines(`claude--v2299-ask-field-${name}.txt`));
    if (model?.phase !== "question") throw new Error(`${name} is not a wizard question step`);
    return model;
  };

  it("the field's digit on an empty field: focused and empty, the step still claimed", () => {
    expect(step("wizard-focused-empty").field).toEqual({
      key: "3",
      focused: true,
      text: "",
      chosen: false,
      pointer: "on",
    });
  });

  it("typed into: the field holds the words", () => {
    expect(step("wizard-focused-typed").field).toMatchObject({ focused: true, text: "Mango", chosen: false });
  });

  it("a step answered by typing, revisited: the ✔ is `chosen`, not part of the text", () => {
    expect(step("wizard-revisit-typed").field).toEqual({
      key: "3",
      focused: false,
      text: "Mango",
      chosen: true,
      pointer: "above",
    });
  });

  it("revisited and focused: the caret cell's space and the ✔ are stripped", () => {
    expect(step("wizard-revisit-focused").field).toEqual({
      key: "3",
      focused: true,
      text: "Mango",
      chosen: true,
      pointer: "on",
    });
  });

  it("revisited and cleared: the placeholder reads as empty, the ✔ stays", () => {
    expect(step("wizard-revisit-cleared").field).toMatchObject({ focused: true, text: "", chosen: true });
  });

  it("the field is never an option, and the options keep their digits", () => {
    for (const name of [
      "wizard-focused-empty",
      "wizard-focused-typed",
      "wizard-revisit-typed",
      "wizard-revisit-focused",
      "wizard-revisit-cleared",
    ]) {
      const model = step(name);
      expect(model.options.map((o) => [o.label, o.keys]), name).toEqual([
        ["Apple", ["1"]],
        ["Pear", ["2"]],
        ["Chat about this", ["4"]],
      ]);
    }
  });

  it("the review step that lists typed answers is still the review", () => {
    const model = detectWizard(fixtureLines("claude--v2299-ask-field-wizard-review-typed.txt"));
    expect(model?.phase).toBe("review");
  });
});

describe("wizardsSameIdentity — the answer recipe's mid-flight comparator", () => {
  const model = (name: string) => {
    const found = detectWizard(fixtureLines(name));
    if (!found) throw new Error(`${name} did not detect a wizard`);
    return found;
  };
  const typed = model("claude--v2299-ask-field-wizard-revisit-typed.txt");
  const focused = model("claude--v2299-ask-field-wizard-revisit-focused.txt");
  const cleared = model("claude--v2299-ask-field-wizard-revisit-cleared.txt");

  it("walking onto the field and clearing it keep the step's identity, and change what it commits on", () => {
    for (const [a, b] of [
      [typed, focused],
      [focused, cleared],
      [typed, cleared],
    ] as const) {
      expect(wizardsSameIdentity(a, b)).toBe(true);
      expect(wizardsEqual(a, b)).toBe(false);
    }
  });

  it("a different question is not the same identity", () => {
    expect(wizardsSameIdentity(typed, model("claude--wizard-q1.txt"))).toBe(false);
    expect(wizardsSameIdentity(typed, model("claude--v2299-ask-field-wizard-focused-empty.txt"))).toBe(false);
  });

  it("an opencode wizard step carries no coreSignature and compares exactly as wizardsEqual", () => {
    const region = detectQuestionTabs(fixtureLines("oc--question--two--q1.txt"));
    if (region?.kind !== "wizard" || region.model.phase !== "question") throw new Error("no opencode wizard step");
    const oc = region.model;
    expect(oc.coreSignature).toBeUndefined();
    expect(wizardsSameIdentity(oc, { ...oc })).toBe(true);
    const moved = { ...oc, signature: `${oc.signature} ` };
    expect(wizardsEqual(oc, moved)).toBe(false);
    expect(wizardsSameIdentity(oc, moved)).toBe(false);
  });
});

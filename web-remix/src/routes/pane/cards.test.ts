/// <reference types="bun" />
// The dialog-to-card mapping over REAL captures (web/src/fixtures/panes), one per harness that has a
// dialog capture. The blocks are built by web's own dispatcher with the agent string the capture was
// taken from; this file only checks what the pane screen draws from them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAnsi } from "@web/lib/ansi";
import { splitLines, type Block } from "@web/lib/blocks";
import { buildBlocks } from "@web/lib/harness";
import { splitWalk } from "@web/lib/harness/prompt-model";

import {
  dialogCardOf,
  dialogOwnsKeyboard,
  mirrorLines,
  type DialogCard,
  type MultiSelectCard,
  type PreviewSelectCard,
  type PromptCard,
  type WizardCard,
} from "./cards";

const FIXTURES = new URL("../../../../web/src/fixtures/panes/", import.meta.url);

function blocksOf(file: string, agent: string): Block[] {
  return buildBlocks(splitLines(parseAnsi(readFileSync(new URL(file, FIXTURES), "utf8"))), { agent });
}

function cardOf(file: string, agent: string): DialogCard | null {
  return dialogCardOf(blocksOf(file, agent));
}

function promptOf(file: string, agent: string): PromptCard {
  const card = cardOf(file, agent);
  if (card?.kind !== "prompt-select") throw new Error(`${file}: expected a prompt card, got ${card?.kind ?? "none"}`);
  return card;
}

const PERMISSION_CASES = [
  { file: "claude--permission-bash.txt", agent: "claude", options: 3, firstKeys: ["1"] },
  { file: "codex--approval-exec.txt", agent: "codex", options: 2, firstKeys: ["1"] },
  { file: "agy--permission-bash.txt", agent: "agy", options: 4 },
  { file: "grok--permission-rm.txt", agent: "grok", options: 2, firstKeys: ["2"] },
  { file: "muse--approval-ls.txt", agent: "muse", options: 3 },
  { file: "oc--permission-bash.txt", agent: "opencode", options: 3, firstKeys: ["Enter"] },
] as const;

describe("permission dialogs, one per harness", () => {
  for (const c of PERMISSION_CASES) {
    test(`${c.agent}: ${c.file}`, () => {
      const card = promptOf(c.file, c.agent);
      expect(card.block.prompt.family).toBe("permission");
      expect(card.options.length).toBe(c.options);
      for (const row of card.options) {
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.badge.length).toBeGreaterThan(0);
        // The card hands back the harness's own option, untouched, for the guarded tap.
        expect(card.block.prompt.options).toContain(row.option);
      }
      if ("firstKeys" in c) expect(card.options[0]!.option.keys).toEqual([...c.firstKeys]);
      expect(card.caption.length).toBeGreaterThan(0);
      // The dialog has the keyboard: a typed reply is refused while it is up.
      expect(dialogOwnsKeyboard([card.block])).toBe(true);
    });
  }

  test("claude: direct digits, no walk", () => {
    const card = promptOf("claude--permission-bash.txt", "claude");
    expect(card.options.map((o) => o.option.keys)).toEqual([["1"], ["2"], ["3"]]);
    for (const o of card.options) expect(splitWalk(o.option.keys)).toBeNull();
  });

  test("grok: the option labels are the screen's", () => {
    const card = promptOf("grok--permission-rm.txt", "grok");
    expect(card.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, reject"]);
  });

  test("opencode: a pointed list walks, then commits (ADR 0080)", () => {
    const card = promptOf("oc--permission-bash.txt", "opencode");
    expect(card.options.map((o) => o.option.keys)).toEqual([["Enter"], ["Right", "Enter"], ["Right", "Right", "Enter"]]);
    expect(splitWalk(card.options[1]!.option.keys)).not.toBeNull();
    // After one step right the pointer sits on "Allow always": its keys are the commit alone.
    const moved = promptOf("oc--permission-bash--moved.txt", "opencode");
    const always = moved.options.find((o) => o.label === card.options[1]!.label);
    expect(always?.option.keys).toEqual(["Enter"]);
  });
});

describe("other card kinds", () => {
  test("a menu carries its footer actions and its advertised arrows", () => {
    const card = cardOf("claude--menu-model-picker.txt", "claude");
    if (card?.kind !== "menu") throw new Error("expected a menu card");
    expect(card.caption).toBe("Select model");
    expect(card.block.menu.nav.upDown).toBe(true);
    expect(card.block.menu.actions.map((a) => a.keys)).toEqual([["Enter"], ["s"], ["Escape"]]);
    expect(card.block.menu.actions.at(-1)?.cancel).toBe(true);
  });

  test("an unread dialog names its one key", () => {
    const card = cardOf("codex--ask-notes-focused.txt", "codex");
    if (card?.kind !== "unread-dialog") throw new Error("expected an unread-dialog card");
    expect(card.block.cancel.key).toBe("Escape");
    expect(card.keyName).toBe("Esc");
  });

  test("an agent with no adapter gets the plain mirror and no card", () => {
    const blocks = blocksOf("claude--permission-bash.txt", "some-future-harness");
    expect(dialogCardOf(blocks)).toBeNull();
    expect(mirrorLines(blocks).length).toBe(blocks.flatMap((b) => b.lines).length);
  });

  test("the mirror leaves out the lines the card took", () => {
    const blocks = blocksOf("claude--permission-bash.txt", "claude");
    const card = dialogCardOf(blocks);
    if (card?.kind !== "prompt-select") throw new Error("expected a prompt card");
    const all = blocks.flatMap((b) => b.lines).length;
    expect(mirrorLines(blocks).length).toBe(all - card.block.lines.length);
  });
});

function wizardOf(file: string): WizardCard {
  const card = cardOf(file, "claude");
  if (card?.kind !== "wizard") throw new Error(`${file}: expected a wizard card, got ${card?.kind ?? "none"}`);
  return card;
}

function multiOf(file: string): MultiSelectCard {
  const card = cardOf(file, "claude");
  if (card?.kind !== "multi-select") throw new Error(`${file}: expected a multi-select card, got ${card?.kind ?? "none"}`);
  return card;
}

function previewOf(file: string): PreviewSelectCard {
  const card = cardOf(file, "claude");
  if (card?.kind !== "preview-select") throw new Error(`${file}: expected a preview-select card, got ${card?.kind ?? "none"}`);
  return card;
}

describe("wizard card", () => {
  test("a question step: answers by digit, the escape apart, the stepper on the first question", () => {
    const card = wizardOf("claude--wizard-q1.txt");
    if (card.block.wizard.phase !== "question") throw new Error("expected a question step");
    expect(card.caption).toBe(card.block.wizard.question);
    // One digit selects and advances; the card hands the harness's own keys back.
    expect(card.answers.map((o) => [o.label, o.keys])).toEqual([
      ["Parser", ["1"]],
      ["UI", ["2"]],
      ["Tests", ["3"]],
    ]);
    expect(card.escapes.map((o) => o.label)).toEqual(["Chat about this"]);
    expect(card.stepper.steps.map((s) => s.label)).toEqual(["Focus area", "Scope", "Workflow"]);
    expect(card.stepper.steps[0]!.current).toBe(true);
    // The TUI clamps at the first question, so Back is disabled and Next is not.
    expect(card.stepper.backDisabled).toBe(true);
    expect(card.stepper.nextDisabled).toBe(false);
    expect(card.stepper.submitCurrent).toBe(false);
    expect(card.stepper.position).toContain("Focus area");
    expect(dialogOwnsKeyboard([card.block])).toBe(true);
  });

  test("a later step enables Back", () => {
    const card = wizardOf("claude--wizard-q2.txt");
    expect(card.stepper.backDisabled).toBe(false);
    expect(card.answers.map((o) => o.label)).toEqual(["Small", "Medium", "Large"]);
  });

  test("a revisited question marks its chosen row", () => {
    const card = wizardOf("claude--wizard-q1-revisit.txt");
    expect(card.answers.filter((o) => o.chosen).length).toBe(1);
  });

  test("a wrapped question keeps its words whole", () => {
    const card = wizardOf("claude--v2283-wizard-two-line-question.txt");
    expect(card.answers.map((o) => o.label)).toEqual(["Apple", "Banana", "Orange"]);
    expect(card.caption.length).toBeGreaterThan(0);
  });

  test("the review step: the Submit chip is current, Next is disabled, no answers to tap", () => {
    for (const file of ["claude--wizard-submit.txt", "claude--wizard-submit-unanswered.txt"]) {
      const card = wizardOf(file);
      expect(card.block.wizard.phase).toBe("review");
      expect(card.stepper.submitCurrent).toBe(true);
      expect(card.stepper.nextDisabled).toBe(true);
      expect(card.stepper.backDisabled).toBe(false);
      expect(card.answers).toEqual([]);
      expect(card.escapes).toEqual([]);
    }
    const unanswered = wizardOf("claude--wizard-submit-unanswered.txt").block.wizard;
    if (unanswered.phase !== "review") throw new Error("expected a review step");
    expect(unanswered.incomplete).toBe(true);
  });
});

describe("multi-select card", () => {
  test("the checkbox screen: terminal state, advance label, escape, no stepper on a single question", () => {
    const card = multiOf("claude--select-multiselect-checked.txt");
    const multi = card.block.multi;
    if (multi.phase !== "checkbox") throw new Error("expected the checkbox phase");
    expect(card.caption).toBe(multi.question);
    expect(multi.options.map((o) => [o.n, o.label, o.checked])).toEqual([
      [1, "Cheese", false],
      [2, "Mushrooms", true],
      [3, "Olives", true],
      [4, "Peppers", false],
    ]);
    expect(multi.advanceLabel).toBe("Submit");
    expect(multi.escape).not.toBeNull();
    expect(card.stepper).toBeNull();
    expect(dialogOwnsKeyboard([card.block])).toBe(true);
  });

  test("a digit toggles on Claude's checkbox screen", () => {
    const multi = multiOf("claude--select-multiselect-single.txt").block.multi;
    if (multi.phase !== "checkbox") throw new Error("expected the checkbox phase");
    expect(multi.toggle).toBe("digit");
    expect(multi.options.every((o) => !o.checked)).toBe(true);
  });

  test("a wizard step carries the stepper and the Next label", () => {
    const card = multiOf("claude--wizard-multiselect-q1.txt");
    expect(card.stepper).not.toBeNull();
    expect(card.stepper!.steps.some((s) => s.current)).toBe(true);
    if (card.block.multi.phase !== "checkbox") throw new Error("expected the checkbox phase");
    expect(card.block.multi.advanceLabel).toBe("Next");
    expect(multiOf("claude--wizard-multiselect-final.txt").block.multi).toMatchObject({ advanceLabel: "Submit" });
  });

  test("the review screen: the heading is the ready-to-submit one, no stepper", () => {
    const card = multiOf("claude--select-multiselect-review.txt");
    expect(card.block.multi.phase).toBe("review");
    expect(card.stepper).toBeNull();
    expect(card.caption).toBe("Ready to submit your answers?");
  });
});

describe("preview-select card", () => {
  test("a single question: options by digit, the caption is the group caption, no stepper", () => {
    const card = previewOf("claude--select-preview.txt");
    const { preview } = card.block;
    expect(preview.options.map((o) => [o.n, o.label])).toEqual([
      [1, "Boxy"],
      [2, "Rounded"],
      [3, "Minimal"],
    ]);
    expect(card.stepper).toBeNull();
    expect(card.caption).toBe("Choose an option");
    expect(card.pointedLabel).toBe(preview.options.find((o) => o.pointed)?.label);
    expect(preview.preview.length).toBeGreaterThan(0);
    expect(card.terminalEditing).toBe(false);
    expect(preview.note.state).toBe("none");
  });

  test("a note on the question is attached, and the terminal's own input locks the card", () => {
    expect(previewOf("claude--select-preview-note-attached.txt").block.preview.note.state).toBe("attached");
    expect(previewOf("claude--select-preview-note-attached.txt").terminalEditing).toBe(false);
    const editing = previewOf("claude--select-preview-note-input.txt");
    expect(editing.block.preview.note.state).toBe("editing");
    expect(editing.terminalEditing).toBe(true);
  });

  test("a wizard step carries the stepper and heads the card with its question", () => {
    const card = previewOf("claude--wizard-preview-q1.txt");
    expect(card.stepper).not.toBeNull();
    expect(card.stepper!.steps.length).toBe(card.block.preview.steps!.length);
    expect(card.caption).toBe(card.block.preview.question);
  });

  test("a wrapped option label stays one option", () => {
    const card = previewOf("claude--wizard-preview-wrapped-label.txt");
    expect(card.block.preview.options.map((o) => o.label)).toEqual([
      "Grid of equal-width cards with a fixed gutter (Recommended)",
      "List",
    ]);
  });
});

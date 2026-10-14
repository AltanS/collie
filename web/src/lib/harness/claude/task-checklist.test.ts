import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type Block, type StyledLine } from "../../blocks";
import { claudeAdapter } from "./index";
import { dropTaskChecklist } from "./task-checklist";

// Claude Code 2.1.299 draws its task checklist under a dialog's footer. See task-checklist.ts for the
// whole story. The captures are in fixtures/panes as `claude--v2299-*-under-*task-list.txt`.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const text = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");
const fixtureLines = (name: string): StyledLine[] => splitLines(parseAnsi(text(name)));
const lastBlock = (lines: StyledLine[]): Block => claudeAdapter.buildBlocks(lines).at(-1)!;

const ASK_SHORT = "claude--v2299-ask-under-task-list.txt";
const ASK_LONG = "claude--v2299-ask-under-long-task-list.txt";
const WIZARD = "claude--v2299-wizard-under-task-list.txt";
const IDLE = "claude-lab--idle-fresh--w82.txt";

describe("a dialog with the task checklist under its footer is read", () => {
  it.each([
    [ASK_SHORT, "Pick a colour?"],
    [ASK_LONG, "Pick a size?"],
  ])("%s lifts a prompt-select with its question", (name, question) => {
    const block = lastBlock(fixtureLines(name));
    expect(block.kind).toBe("prompt-select");
    if (block.kind === "prompt-select") expect(block.prompt.question).toBe(question);
  });

  it("the wizard step lifts a wizard with its question", () => {
    const block = lastBlock(fixtureLines(WIZARD));
    expect(block.kind).toBe("wizard");
    if (block.kind === "wizard" && block.wizard.phase === "question") expect(block.wizard.question).toBe("Pick a colour?");
  });

  it("the long list is a modal on screen, and the composer is not offered", () => {
    const lines = fixtureLines(ASK_LONG);
    expect(claudeAdapter.modalOnScreen!(lines)).toBe(true);
    expect(claudeAdapter.composerReady!(lines)).toBe(false);
  });

  it("drops the checklist rows and nothing above them", () => {
    const lines = fixtureLines(ASK_LONG);
    const dropped = dropTaskChecklist(lines);
    expect(dropped.length).toBeLessThan(lines.length);
    expect(dropped).toEqual(lines.slice(0, dropped.length));
  });
});

describe("it fails closed", () => {
  it("hands back the very same array for an idle screen with an input box", () => {
    const lines = fixtureLines(IDLE);
    expect(dropTaskChecklist(lines)).toBe(lines);
  });

  it("hands back the very same array for a dialog with no checklist", () => {
    const lines = fixtureLines("claude-lab--ask-single-v2296--w82.txt");
    expect(dropTaskChecklist(lines)).toBe(lines);
    expect(dropTaskChecklist([])).toEqual([]);
  });

  it("leaves a checklist alone while an input box is on screen", () => {
    const raw = `${text(IDLE)}\n  2 tasks (1 done, 1 open)\n  ✔ Alpha step\n  ◻ Bravo step\n`;
    const lines = splitLines(parseAnsi(raw));
    expect(dropTaskChecklist(lines)).toBe(lines);
  });
});

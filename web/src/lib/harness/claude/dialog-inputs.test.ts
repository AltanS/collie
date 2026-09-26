import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { buildBlocks } from "../index";
import { claudeAdapter } from ".";
import { classifyFooter, namesPermissionDialog, questionRowText } from "./markers";
import { detectMultiSelect } from "./multi-select";
import { detectPromptSelect } from "./prompt-select";
import { detectWizard } from "./wizard";

// Dialogs Claude Code 2.1.283 paints that Collie could not read, or read wrong, captured live on
// 2026-09-26 (fixtures `claude--v2283-*`, web/src/fixtures/panes/README.md). Each block below is one
// finding: what the screen is, what the phone showed, and what it must show now.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);
const claudeBlocks = (name: string) => buildBlocks(fixtureLines(name), { agent: "claude" });

describe("a permission dialog is read by its own words, not only by 'Tab to amend'", () => {
  it("names the dialog from its question and its Yes … No rows", () => {
    const texts = fixtureLines("claude--v2283-permission-amend-focused.txt").map(lineText);
    expect(namesPermissionDialog(texts)).toBe(true);
    expect(classifyFooter("Esc to cancel", texts)).toBe("permission");
  });

  it("a bare 'Esc to cancel' claims nothing on a screen that is not a permission dialog", () => {
    const texts = fixtureLines("claude-lab--menu-status-screen--w82.txt").map(lineText);
    expect(namesPermissionDialog(texts)).toBe(false);
    expect(classifyFooter("Esc to cancel", texts)).toBeNull();
  });

  it("the WebFetch dialog, which prints no footer, lifts with its three digits", () => {
    const model = detectPromptSelect(fixtureLines("claude-lab--permission-webfetch--w82.txt"))!;
    expect(model.family).toBe("permission");
    expect(model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(model.feedback).toBeUndefined();
  });

  it("a label wrapped at 40 columns stays one label, never a label plus a description", () => {
    const model = detectPromptSelect(fixtureLines("claude-lab--permission-bash--w40.txt"))!;
    expect(model.family).toBe("permission");
    const always = model.options.find((o) => o.keys[0] === "2")!;
    expect(always.label).toBe("Yes, and always allow access to /tmp/claude-lab/project from this project");
    expect(always.description).toBeUndefined();
  });
});

describe("the amend note (Tab on Yes or No) is a field, never a button", () => {
  it("focused and empty: the Yes row is the field, every other button is locked", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-permission-amend-focused.txt"))!;
    expect(model.family).toBe("permission");
    expect(model.feedback).toEqual({ key: "1", focused: true, text: "", purpose: "free-text" });
    expect(model.options.map((o) => o.keys[0])).toEqual(["2", "3", "4"]);
  });

  it("focused with two typed lines: the value is rejoined without the 'Yes, ' the row paints", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-permission-amend-typed.txt"))!;
    expect(model.feedback).toEqual({
      key: "1",
      focused: true,
      text: "use b instead and also c",
      purpose: "free-text",
    });
  });

  it("a note on the No row, pointer elsewhere: not focused, and the other rows answer", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-permission-amend-no-off-row.txt"))!;
    expect(model.feedback).toEqual({
      key: "4",
      focused: false,
      text: "use echo c instead",
      purpose: "free-text",
    });
    expect(model.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /tmp/collie-claude-debug from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
    ]);
  });

  it("none of the three shows the unread-dialog card any more", () => {
    for (const name of [
      "claude--v2283-permission-amend-focused.txt",
      "claude--v2283-permission-amend-typed.txt",
      "claude--v2283-permission-amend-no-off-row.txt",
    ]) {
      expect(kinds(claudeBlocks(name)), name).toContain("prompt-select");
    }
  });
});

describe("AskUserQuestion's 'Type something.' row is found by position, typed or not", () => {
  it("pointer on the empty field: modelled as focused, so no button can type a digit into it", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-ask-type-something-focused.txt"))!;
    expect(model.feedback).toEqual({ key: "4", focused: true, text: "", purpose: "free-text" });
    expect(model.options.map((o) => o.label)).not.toContain("Type something.");
  });

  it("two typed lines never become an option button carrying someone's words", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-ask-type-something-typed-two-lines.txt"))!;
    expect(model.feedback).toEqual({
      key: "4",
      focused: true,
      text: "my own answer second line of my answer",
      purpose: "free-text",
    });
    expect(model.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Orange", "Chat about this"]);
  });

  it("typed, pointer moved off: the field shows its value and the answers stay pressable", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-ask-type-something-typed-off-row.txt"))!;
    expect(model.feedback).toEqual({ key: "3", focused: false, text: "1", purpose: "free-text" });
    expect(model.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Chat about this"]);
  });

  it("multi-select with the pointer on the field is not claimed (a toggle would type into it)", () => {
    const lines = fixtureLines("claude--v2283-multiselect-type-something-focused.txt");
    expect(detectMultiSelect(lines)).toBeNull();
    expect(kinds(buildBlocks(lines, { agent: "claude" }))).not.toContain("multi-select");
  });

  it("a wizard step with the pointer on the field is not claimed either", () => {
    const text = readFileSync(join(PANES_DIR, "claude--v2283-wizard-two-line-question.txt"), "utf8");
    // Move the pointer from "1. Apple" onto "4. Type something." the way Down×3 repaints it. The
    // pointer is the `❯ ` just before "1. "; the first `❯` in the file is an old prompt row.
    const grey = "\u001b[0m\u001b[38;2;153;153;153m";
    const moved = text
      .replace(`❯ ${grey}1. `, `  ${grey}1. `)
      .replace(`\n  ${grey}4. Type something.`, `\n❯ ${grey}4. Type something.`);
    expect(moved).not.toBe(text);
    expect(detectWizard(splitLines(parseAnsi(text)))).not.toBeNull();
    expect(detectWizard(splitLines(parseAnsi(moved)))).toBeNull();
  });
});

describe("a question is the whole paragraph, without the │ gutter", () => {
  it("a question the agent wrote on two lines", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-ask-two-line-question.txt"))!;
    expect(model.question).toBe("Which fruit do you want? Pick the one you like best.");
  });

  it("a long question wrapped at 50 columns, not just its last row", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-ask-long-question--w50.txt"))!;
    expect(model.question).toBe(
      "Which single piece of fresh fruit would you most like me to pack in your lunch box for a healthy midday snack at work today?",
    );
  });

  it("the folder-trust paragraph at 50 columns, not its middle row", () => {
    const model = detectPromptSelect(fixtureLines("claude--v2283-trust--w50.txt"))!;
    expect(model.family).toBe("trust");
    expect(model.question.startsWith("Quick safety check: Is this a project you created")).toBe(true);
    expect(model.question.endsWith("take a moment to review what's in this folder first.")).toBe(true);
  });

  it("the wizard's question drops the gutter too", () => {
    const model = detectWizard(fixtureLines("claude--v2283-wizard-two-line-question.txt"))!;
    expect(model.phase).toBe("question");
    if (model.phase !== "question") return;
    expect(model.question).toBe("Which fruit? Think about taste.");
  });

  it("questionRowText strips the gutter and nothing else", () => {
    expect(questionRowText("│ Which fruit?")).toBe("Which fruit?");
    expect(questionRowText("   Which fruit?  ")).toBe("Which fruit?");
    expect(questionRowText("a │ b")).toBe("a │ b");
  });
});

describe("the plan dialog under a custom config dir, its footer wrapped onto the plan path", () => {
  it("lifts as the plan family", () => {
    for (const name of [
      "claude-lab--plan-approval--w82.txt",
      "claude-lab--plan-approval--w82--h30.txt",
      "claude-lab--plan-approval-feedback-typed--w82.txt",
    ]) {
      expect(detectPromptSelect(fixtureLines(name))?.family, name).toBe("plan");
    }
  });

  it("a plans/*.md path alone claims nothing without the footer's own ctrl+g row", () => {
    expect(classifyFooter("/tmp/x/plans/a-plan.md", ["notes", "/tmp/x/plans/a-plan.md"])).toBeNull();
  });
});

describe("the shell under a starting or exiting Claude gets no unread-dialog card", () => {
  it.each(["claude--v2283-shell-before-first-frame.txt", "claude--v2283-shell-after-exit.txt"])(
    "%s",
    (name) => {
      const lines = fixtureLines(name);
      // Still no input box: a send there is refused by the reply pre-flight, as before.
      expect(claudeAdapter.composerReady!(lines)).toBe(false);
      expect(claudeAdapter.modalOnScreen!(lines)).toBe(false);
      expect(kinds(buildBlocks(lines, { agent: "claude" }))).toEqual(["raw"]);
    },
  );
});

describe("review fixes: a wrapped reject row, a footerless claim, and the card's evidence", () => {
  const plain = (rows: string[]) => splitLines(parseAnsi(rows.join("\n")));
  const webfetch = (pointer: boolean) =>
    plain([
      "─".repeat(50),
      " Fetch",
      "   url: https://example.com/",
      "",
      " Do you want to allow Claude to fetch this content?",
      ` ${pointer ? "❯" : " "} 1. Yes`,
      "   2. Yes, and don't ask again for example.com",
      "   3. No, and tell Claude what to do differently",
      "      (esc)",
    ]);

  it("a reject row whose '(esc)' wrapped onto its own row stays a button, not an amend note", () => {
    const model = detectPromptSelect(webfetch(true))!;
    expect(model.family).toBe("permission");
    expect(model.feedback).toBeUndefined();
    expect(model.options.at(-1)).toEqual({
      label: "No, and tell Claude what to do differently (esc)",
      description: undefined,
      keys: ["3"],
    });
  });

  it("with no footer, the same words without a live pointer claim nothing", () => {
    expect(detectPromptSelect(webfetch(false))).toBeNull();
  });

  it("a missed select's pointer, or a 'Press Enter' prompt, still counts as a modal for the card", () => {
    expect(claudeAdapter.modalOnScreen!(plain(["Pick one", "❯ 1. Alpha", "  2. Beta"]))).toBe(true);
    expect(claudeAdapter.modalOnScreen!(plain(["Setup finished.", "Press Enter to continue…"]))).toBe(true);
    expect(claudeAdapter.modalOnScreen!(plain(["user in host in ~/src", "❯ claude"]))).toBe(false);
  });
});

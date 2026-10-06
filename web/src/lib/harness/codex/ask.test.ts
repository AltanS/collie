import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { codexAdapter } from "./index";
import { detectAskRegion } from "./ask";
import { lineText } from "./markers";

const fruit = readFileSync(join(import.meta.dirname, "../../../fixtures/panes/codex--ask-fruit.txt"), "utf8");
const linesOf = (text: string) => splitLines(parseAnsi(text));

describe("the card starts at the question, so the mirror above it does not repeat it", () => {
  it.each([
    ["codex--ask-fruit.txt", "Pick a fruit?"],
    ["codex--ask-wizard-q1.txt", ""],
    ["codex--ask-wizard-q2.txt", "Semicolons?"],
  ])("%s", (name, question) => {
    const lines = linesOf(readFileSync(join(import.meta.dirname, "../../../fixtures/panes", name), "utf8"));
    const region = detectAskRegion(lines)!;
    const text = question === "" ? region.model.question : question;
    const [raw, prompt] = codexAdapter.buildBlocks(lines);
    expect(raw?.kind).toBe("raw");
    expect(prompt?.kind).toBe("prompt-select");
    // The `Question X/Y` header stays above; the question row itself moved into the block.
    const mirrorTail = raw!.lines.slice(-3).map(lineText).join("\n");
    expect(mirrorTail).toContain("Question ");
    expect(mirrorTail).not.toContain(text);
    expect(lineText(prompt!.lines[0]!).trim()).toBe(text);
  });

  it("a wrapped question moves whole: every question row is in the block", () => {
    const lines = linesOf(fruit.replaceAll("Pick a fruit?", "Pick a\n  fruit?"));
    const [raw, prompt] = codexAdapter.buildBlocks(lines);
    expect(raw!.lines.slice(-3).map(lineText).join("\n")).not.toContain("Pick a");
    expect(prompt!.lines.slice(0, 2).map((l) => lineText(l).trimEnd()).join("|")).toBe("  Pick a|  fruit?");
  });
});

// Layout-only variants of the public capture, not new live captures.
describe("wrapped Codex questions", () => {
  it.each(["question", "description", "footer", "all"])("lifts a wrapped %s", (part) => {
    let screen = fruit;
    if (part === "question" || part === "all") screen = screen.replaceAll("Pick a fruit?", "Pick a\n  fruit?");
    if (part === "description" || part === "all") {
      screen = screen.replace("Choose a soft, juicy pear.", "Choose a soft,\n                                              juicy pear.");
    }
    if (part === "footer" || part === "all") screen = screen.replace(" | esc to interrupt", "\n  esc to interrupt");
    const lines = linesOf(screen);
    const ask = detectAskRegion(lines);
    expect(ask?.model.question).toBe("Pick a fruit?");
    expect(ask?.model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(ask?.model.options[1]?.description).toBe("Choose a soft, juicy pear.");
    const prompt = codexAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.lines.map(lineText).join("\n")).toContain("1. Apple");
    expect(codexAdapter.composerReady!(lines)).toBe(false);
    expect(detectAskRegion(linesOf(screen + "\nnew output"))).toBeNull();
    if (part === "all") {
      const changed = detectAskRegion(linesOf(screen.replace("juicy pear", "green pear")));
      expect(changed?.model.signature).not.toBe(ask?.model.signature);
    }
  });

  it.each(["        unexpected row", "                                              10. Another option", "  › Add notes", ""])(
    "refuses an invalid option continuation: %j", (row) => {
      const screen = [
        "  Question 1/1 (1 unanswered)", "  Pick?", "",
        "  › 1. A  First description", row, "    2. B  Second description", "",
        "  tab to add notes | enter to submit answer", "  esc to interrupt",
      ].join("\n");
      expect(detectAskRegion(linesOf(screen))).toBeNull();
    },
  );

  it("refuses continuations without a description", () => {
    const screen = [
      "  Question 1/1 (1 unanswered)", "  Pick?", "",
      "  › 1. A", "              continuation", "    2. B", "",
      "  tab to add notes | enter to submit answer", "  esc to interrupt",
    ].join("\n");
    expect(detectAskRegion(linesOf(screen))).toBeNull();
  });

  it("refuses notes mode with a wrapped footer", () => {
    const notes = readFileSync(join(import.meta.dirname, "../../../fixtures/panes/codex--ask-notes-focused.txt"), "utf8")
      .replace(" | esc to interrupt", "\n  esc to interrupt");
    expect(detectAskRegion(linesOf(notes))).toBeNull();
  });
});

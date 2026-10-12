import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
import { askModalOnScreen, detectAskSelectRegion } from "./ask";

const PANES = join(import.meta.dirname, "../../../fixtures/panes");
const single = readFileSync(join(PANES, "pi--omo-v5130-single-described.txt"), "utf8");
const linesOf = (text: string) => splitLines(parseAnsi(text));
const capture = (name: string) => linesOf(readFileSync(join(PANES, `pi--omo-v5130-${name}.txt`), "utf8"));

describe("OmO single-question selection", () => {
  it("offers digit-only answers when an unanswered single-choice dialog is captured", () => {
    const model = detectAskSelectRegion(linesOf(single))?.model;
    expect(model?.question).toBe("Pick a color for the Collie sandbox probe?");
    expect(model?.options).toEqual([
      { label: "Red (Recommended)", description: "Warm color.", keys: ["1"] },
      { label: "Green", description: "Cool color.", keys: ["2"] },
      { label: "Blue", description: "Deep color.", keys: ["3"] },
      { label: "Cancel", keyLabel: "Esc", keys: ["Escape"] },
    ]);
  });

  it("keeps digit addressing when the desk pointer moves to another option", () => {
    const first = detectAskSelectRegion(capture("single-described"))?.model;
    const moved = detectAskSelectRegion(capture("single-described-moved"))?.model;
    expect(moved?.options).toEqual(first?.options);
    expect(first).toBeDefined();
    expect(moved).toBeDefined();
    if (first === undefined || moved === undefined) throw new Error("capture did not lift");
    expect(promptsEqual(first, moved)).toBe(false);
  });

  it.each(["multi", "single-other-focused", "answer-editor"])(
    "keeps the %s screen raw rather than assigning a submission recipe", (name) => {
      const lines = capture(name);
      expect(detectAskSelectRegion(lines)).toBeNull();
      expect(askModalOnScreen(lines)).toBe(true);
    },
  );

  it.each([
    ["another footer", single.replace("space", "ctrl+s")],
    ["several questions", single.replace("(0/1 answered)", "(0/2 answered)")],
    ["an answered question", single.replace("(0/1 answered)", "(1/1 answered)")],
    ["a selected row", single.replace("Green", "Green ✓")],
    ["noncontiguous numbers", single.replace("2.", "4.")],
    ["a tenth option", single.replace("3.", "10.")],
    ["a missing Other row", single.replace("Type your own answer...", "Unknown action")],
    ["an extra tab", single.replace("Submit\x1b", "Other tab    Submit\x1b")],
    ["a renamed title", single.replace("Ask user", "Model picker")],
    ["a missing description", single.replace("Warm color.", "")],
    ["a missing pointer", single.replace("→ \x1b", "  \x1b")],
  ])("declines the dialog when it has %s", (_name, text) => {
    expect(detectAskSelectRegion(linesOf(text))).toBeNull();
  });

  it("does not lift a dialog when plain output follows its status tail", () => {
    const output: StyledLine = { segments: [{ text: "Agent resumed", style: {}, muted: false }] };
    expect(detectAskSelectRegion([...linesOf(single), output])).toBeNull();
  });

  it("changes the committing signature when the question or countdown changes", () => {
    const model = detectAskSelectRegion(linesOf(single))?.model;
    expect(model).toBeDefined();
    if (model === undefined) throw new Error("capture did not lift");
    for (const changed of [
      single.replace("Pick a color", "Choose a color"),
      single.replace("30m", "29m"),
    ]) {
      const fresh = detectAskSelectRegion(linesOf(changed))?.model;
      expect(fresh).toBeDefined();
      if (fresh === undefined) throw new Error("changed capture did not lift");
      expect(promptsEqual(model, fresh)).toBe(false);
    }
  });

  it("binds only the dialog region and leaves changing status counters outside it", () => {
    const lines = linesOf(single);
    const region = detectAskSelectRegion(lines);
    expect(region?.model.signature).toBe(
      lines.slice(0, 16).map((line) => lineText(line).trimEnd()).join("\n"),
    );
    expect(region?.endLine).toBe(16);
  });
});
